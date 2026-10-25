"""Append-only SQLite event log. Events are never updated or deleted; corrections are new events."""
import sqlite3
import threading
import time
from collections.abc import Callable
from pathlib import Path

from app.ledger.events import Event, Kind, Posting, Source


class EventStore:
    def __init__(self, path: Path, device_id: str, wall_clock: Callable[[], float] = time.time):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.device_id = device_id
        self.wall_clock = wall_clock      # untrusted; stored for display only
        # One connection shared by API threads and the mic thread; the lock keeps
        # frontier-read + insert atomic so two local events can never get the same seq.
        self._lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                body TEXT NOT NULL,
                UNIQUE (device_id, seq)
            )"""
        )
        self.db.commit()

    # --- reading -------------------------------------------------------------
    def all(self) -> list[Event]:
        with self._lock:
            rows = self.db.execute("SELECT body FROM events").fetchall()
        return [Event.model_validate_json(r[0]) for r in rows]

    def frontier(self) -> dict[str, int]:
        """Highest seq seen per device — this device's current vector clock."""
        with self._lock:
            rows = self.db.execute("SELECT device_id, MAX(seq) FROM events GROUP BY device_id").fetchall()
        return {d: s for d, s in rows}

    def missing_for(self, their_frontier: dict[str, int]) -> list[Event]:
        """Events we have that a peer with `their_frontier` has not seen."""
        with self._lock:
            rows = self.db.execute("SELECT device_id, seq, body FROM events").fetchall()
        return [Event.model_validate_json(b) for d, s, b in rows if s > their_frontier.get(d, 0)]

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
            seq = vc.get(self.device_id, 0) + 1
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
        return ev

    def ingest(self, events: list[Event]) -> int:
        """Merge events from a peer. Set union: duplicates are ignored, so merge order doesn't matter."""
        added = 0
        with self._lock:
            for ev in events:
                added += self._insert(ev)
        return added

    def _insert(self, ev: Event) -> int:
        with self._lock:
            cur = self.db.execute(
                "INSERT OR IGNORE INTO events (id, device_id, seq, body) VALUES (?, ?, ?, ?)",
                (ev.id, ev.device_id, ev.seq, ev.model_dump_json()),
            )
            self.db.commit()
        return cur.rowcount


def causal_order(events: list[Event]) -> list[Event]:
    """Deterministic order every device agrees on: causal first, then (device_id, seq) tie-break.

    Wall time is deliberately ignored.
    """
    # Sum of the vector clock is a linear extension of happened-before; ties broken deterministically.
    return sorted(events, key=lambda e: (sum(e.vclock.values()), e.device_id, e.seq))
