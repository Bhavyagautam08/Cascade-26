"""Append-only SQLite event log. Events are never updated or deleted; corrections are new events."""
import bisect
import re
import sqlite3
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from app.ledger.events import Event, Kind, Posting, Source

ACTOR_RE = re.compile(r"[A-Za-z0-9_.-]+")    # an event's device_id: no ":" (ids are device_id:seq), no spaces

Have = dict[str, list[list[int]]]            # {device_id: [[first_seq, last_seq], ...]} held ranges


@dataclass
class IngestResult:
    added: int = 0
    duplicates: int = 0                                  # already had it (normal on re-sync)
    rejected: list[dict] = field(default_factory=list)   # {"id", "reason"}


def _holds(ranges: list[tuple[int, int]], seq: int) -> bool:
    i = bisect.bisect_right(ranges, (seq, float("inf"))) - 1
    return i >= 0 and ranges[i][0] <= seq <= ranges[i][1]


class EventStore:
    def __init__(self, path: Path, device_id: str, wall_clock: Callable[[], float] = time.time):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.device_id = device_id
        self.wall_clock = wall_clock      # untrusted; stored for display only
        # One connection shared by API threads and the mic thread; the lock keeps
        # frontier-read + insert atomic so two local events can never get the same seq.
        self._lock = threading.RLock()
        # Called with "local" or "ingest" after the book gained entries (the sync engine wakes up on it).
        self.listeners: list[Callable[[str], None]] = []
        self.path = path
        self._open()

    def _open(self) -> None:
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                body TEXT NOT NULL,
                UNIQUE (device_id, seq)
            )"""
        )
        self.db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.db.commit()

    def _notify(self, why: str) -> None:
        for fn in list(self.listeners):
            fn(why)

    # --- facts about this ledger file (its owner's name, its actor id) ---------
    def get_meta(self, key: str) -> str | None:
        with self._lock:
            row = self.db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def set_meta(self, key: str, value: str) -> None:
        with self._lock:
            self.db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))
            self.db.commit()

    # --- reading -------------------------------------------------------------
    def all(self) -> list[Event]:
        with self._lock:
            rows = self.db.execute("SELECT body FROM events").fetchall()
        return [Event.model_validate_json(r[0]) for r in rows]

    def frontier(self) -> dict[str, int]:
        """Per device, the highest seq up to which we hold *every* event (1..n, no gaps).

        Using the plain maximum would be wrong after a partial sync: a peer would think we already
        have the events in the gap and never send them.
        """
        with self._lock:
            rows = self.db.execute("SELECT device_id, seq FROM events ORDER BY device_id, seq").fetchall()
        out: dict[str, int] = {}
        for device, seq in rows:
            if seq == out.get(device, 0) + 1:
                out[device] = seq
        return out

    def _max_own_seq(self) -> int:
        with self._lock:
            row = self.db.execute("SELECT MAX(seq) FROM events WHERE device_id = ?", (self.device_id,)).fetchone()
        return row[0] or 0

    def have(self) -> Have:
        """Per device, the ranges of seqs held: {"a": [[1, 40], [42, 50]]}. Unlike the frontier it also says
        what is held beyond a gap, so a peer sends exactly the missing entries and nothing twice."""
        with self._lock:
            rows = self.db.execute("SELECT device_id, seq FROM events ORDER BY device_id, seq").fetchall()
        out: Have = {}
        for device, seq in rows:
            ranges = out.setdefault(device, [])
            if ranges and ranges[-1][1] + 1 == seq:
                ranges[-1][1] = seq
            else:
                ranges.append([seq, seq])
        return out

    def missing(self, have: Have, after: tuple[str, int] | None = None,
                limit: int | None = None) -> tuple[list[Event], bool]:
        """Entries a peer holding `have` lacks, in (device_id, seq) order, after the cursor `after`.

        -> (page, more). The caller moves the cursor to the page's last entry, so every page moves
        forward even when the peer refuses some entries: one bad entry can never stall a sync.
        """
        held = {d: sorted((int(lo), int(hi)) for lo, hi in rs) for d, rs in have.items()}
        d0, s0 = after or ("", 0)
        with self._lock:
            rows = self.db.execute(
                "SELECT device_id, seq FROM events WHERE device_id > ? OR (device_id = ? AND seq > ?) "
                "ORDER BY device_id, seq", (d0, d0, s0)).fetchall()
            wanted = [(d, s) for d, s in rows if not _holds(held.get(d, []), s)]
            more = limit is not None and len(wanted) > limit
            wanted = wanted[:limit] if limit is not None else wanted
            page = [Event.model_validate_json(self.db.execute(
                "SELECT body FROM events WHERE device_id = ? AND seq = ?", (d, s)).fetchone()[0])
                for d, s in wanted]
        return page, more

    def missing_for(self, their_frontier: dict[str, int]) -> list[Event]:
        """Events we have that a peer with `their_frontier` (gap-free, see frontier()) has not seen."""
        return self.missing({d: [[1, n]] for d, n in their_frontier.items() if n > 0})[0]

    # --- writing -------------------------------------------------------------
    def append_local(
        self,
        kind: Kind,
        source: Source,
        postings: list[Posting],
        payload: dict | None = None,
        confidence: float = 1.0,
        raw: str | None = None,
        supersedes: list[str] | None = None,
    ) -> Event:
        with self._lock:
            vc = self.frontier()
            seq = self._max_own_seq() + 1
            vc[self.device_id] = seq
            ev = Event(
                id=f"{self.device_id}:{seq}",
                device_id=self.device_id,
                seq=seq,
                vclock=vc,
                wall_time=self.wall_clock(),
                kind=kind,
                source=source,
                confidence=confidence,
                payload=payload or {},
                postings=postings,
                raw=raw,
                supersedes=supersedes or [],
            )
            self._insert(ev)
        self._notify("local")
        return ev

    def ingest(self, events: list[Event]) -> IngestResult:
        """Merge events from a peer. Set union, so merge order doesn't matter.

        Rejected: ids that don't match device_id:seq, a vector clock that doesn't count the event
        itself, and an id we already hold with *different* content (corruption or forgery: the
        log is immutable, so the first version wins and the clash is reported).
        One transaction: a failure part-way leaves the ledger as it was.
        """
        res = IngestResult()
        with self._lock:
            try:
                for ev in events:
                    reason = None
                    if (ev.device_id == "fusion" or not ACTOR_RE.fullmatch(ev.device_id) or ev.seq < 1
                            or ev.id != f"{ev.device_id}:{ev.seq}"):
                        reason = "id must be device_id:seq with seq >= 1 (device_id: letters, digits, . _ -)"
                    elif ev.vclock.get(ev.device_id) != ev.seq:
                        reason = "vclock must count the event itself"
                    if reason is None:
                        row = self.db.execute("SELECT body FROM events WHERE id = ?", (ev.id,)).fetchone()
                        if row is None:
                            res.added += self._insert(ev, commit=False)
                            continue
                        if Event.model_validate_json(row[0]) == ev:
                            res.duplicates += 1
                            continue
                        reason = "different content already stored under this id"
                    res.rejected.append({"id": ev.id, "reason": reason})
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise
        if res.added:
            self._notify("ingest")
        return res

    def _insert(self, ev: Event, commit: bool = True) -> int:
        with self._lock:
            cur = self.db.execute(
                "INSERT OR IGNORE INTO events (id, device_id, seq, body) VALUES (?, ?, ?, ?)",
                (ev.id, ev.device_id, ev.seq, ev.model_dump_json()),
            )
            if commit:
                self.db.commit()
        return cur.rowcount


def causal_order(events: list[Event]) -> list[Event]:
    """Deterministic order every device agrees on: causal first, then (device_id, seq) tie-break.

    Wall time is deliberately ignored.
    """
    # Sum of the vector clock is a linear extension of happened-before; ties broken deterministically.
    return sorted(events, key=lambda e: (sum(e.vclock.values()), e.device_id, e.seq))
