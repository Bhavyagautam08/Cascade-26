"""Keeps the family's phones in sync by itself.

A round exchanges entries with every peer at once (protocol.exchange). Rounds run every SYNC_INTERVAL_S,
and straight away (after min_gap_s) whenever this ledger gains an entry - recorded here or received from
a peer - so the phones stay seconds apart while they share a network. That also bounds how "concurrent"
two phones' entries can be while they are together, which fusion.py relies on to spot one trade heard
by two phones.

Rounds never overlap. Each peer's last outcome is kept for the status page, using the monotonic clock
only (a phone's wall clock may say 1970). Errors are never swallowed: unreachable / refused / protocol
errors are shown per peer, and a bug is shown and logged with its traceback.
"""
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from app.ledger.store import EventStore
from app.sync import protocol

log = logging.getLogger("sync")
KEEP_REJECTED = 20          # refusals kept per peer for the status page


@dataclass
class PeerState:
    url: str
    name: str | None = None
    actor: str | None = None
    state: str = "never"                  # never | ok | unreachable | refused | error
    last_ok: float | None = None          # monotonic
    last_attempt: float | None = None
    last_error: str | None = None
    failures_in_a_row: int = 0
    last: dict = field(default_factory=dict)        # the last good exchange: pulled, pushed, duplicates
    pulled_total: int = 0
    pushed_total: int = 0
    rejected: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class SyncEngine:
    def __init__(self, store: EventStore, peers: list[protocol.Peer], interval_s: float, min_gap_s: float = 1.0,
                 page: int = protocol.PAGE, clock=time.monotonic):
        self.store, self.peers, self.interval_s, self.min_gap_s, self.page = store, peers, interval_s, min_gap_s, page
        self.clock = clock
        self.states = {p.url: PeerState(p.url) for p in peers}
        self.rotations: list[dict] = []
        self._round = threading.Lock()
        self._wake, self._stop = threading.Event(), threading.Event()
        self._thread: threading.Thread | None = None
        self.rounds = 0
        store.listeners.append(self._on_change)

    def _on_change(self, _why: str) -> None:
        self._wake.set()

    # --- running ---------------------------------------------------------------------------------
    @property
    def auto(self) -> bool:
        return self.interval_s > 0 and bool(self.peers)

    def start(self) -> None:
        if not self.auto or (self._thread and self._thread.is_alive()):
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="sync", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 10) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout)

    def _loop(self) -> None:
        self._wake.set()                              # first round right away
        while not self._stop.is_set():
            self._wake.wait(self.interval_s)
            if self._stop.is_set():
                break
            self._wake.clear()
            self.run_once()
            self._stop.wait(self.min_gap_s)           # a burst of new entries -> one round, not one each

    def run_once(self) -> dict[str, dict]:
        """One round with every peer, in parallel. -> {url: what happened, or {"error", "state"}}."""
        with self._round:
            self.rounds += 1
            if not self.peers:
                return {}
            with ThreadPoolExecutor(max_workers=len(self.peers), thread_name_prefix="sync-peer") as pool:
                return dict(zip((p.url for p in self.peers), pool.map(self._one, self.peers)))

    def _one(self, peer: protocol.Peer) -> dict:
        st, now = self.states[peer.url], self.clock()
        st.last_attempt = now
        try:
            rep = protocol.exchange(self.store, peer, self.page, known_actor=st.actor)
        except protocol.Unreachable as e:
            return self._failed(st, "unreachable", str(e))
        except protocol.PeerRefused as e:
            return self._failed(st, "refused", str(e))
        except protocol.ProtocolError as e:
            return self._failed(st, "error", str(e))
        except Exception as e:                        # a bug: shown on the page and logged in full
            log.exception("sync with %s failed", peer.url)
            return self._failed(st, "error", f"bug: {type(e).__name__}: {e}")
        st.state, st.last_ok, st.last_error, st.failures_in_a_row = "ok", now, None, 0
        st.name, st.actor, st.warnings = rep["peer_name"], rep["peer_actor"], rep["warnings"]
        st.last = {k: rep[k] for k in ("pulled", "pushed", "duplicates")}
        st.pulled_total += rep["pulled"]
        st.pushed_total += rep["pushed"]
        if rep["rejected"]:
            st.rejected = (st.rejected + rep["rejected"])[-KEEP_REJECTED:]
            log.warning("sync with %s: %d entries refused: %s", peer.url, len(rep["rejected"]), rep["rejected"][:3])
        for r in rep["rotated"]:
            self.rotations.append({**r, "peer": peer.url})
            log.warning("actor switched during sync with %s: %s", peer.url, r)
        return {**rep, "added": rep["pulled"]}

    def _failed(self, st: PeerState, state: str, error: str) -> dict:
        st.state, st.last_error = state, error
        st.failures_in_a_row += 1
        return {"error": error, "state": state}

    # --- reporting -------------------------------------------------------------------------------
    def status(self) -> dict:
        now = self.clock()

        def ago(t):
            return None if t is None else round(now - t, 1)

        return {
            "auto": self.auto,
            "interval_s": self.interval_s,
            "running": bool(self._thread and self._thread.is_alive()),
            "rounds": self.rounds,
            "name": self.store.name,
            "actor": self.store.device_id,
            "previous_actors": self.store.previous_actors(),
            "rotations": self.rotations,
            "peers": [{
                "url": s.url, "name": s.name, "actor": s.actor, "state": s.state,
                "last_ok_s_ago": ago(s.last_ok), "last_attempt_s_ago": ago(s.last_attempt),
                "last_error": s.last_error, "failures_in_a_row": s.failures_in_a_row, "last": s.last,
                "pulled_total": s.pulled_total, "pushed_total": s.pushed_total,
                "rejected": s.rejected, "warnings": s.warnings,
            } for s in self.states.values()],
        }
