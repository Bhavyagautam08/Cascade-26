"""Business days without trusting any clock.

"Start a new day" appends a `day_start` event. An event belongs to the newest day start it had SEEN:
its vector clock covers the marker (event.vclock[marker.device] >= marker.seq). So:
- a phone whose clock jumped to 1970 still files every event in the right day;
- a phone that hasn't heard of the new day yet keeps booking into the old one, and once the marker
  syncs in, its next events join the new day - and every phone computes the same days;
- two phones starting the day concurrently both create day N+1: the same day.

Nothing is archived or deleted. Day-scoped views (today's profit, today's entries) filter by day;
balances, udhaar and disputes are cumulative, because a debt doesn't vanish overnight.
The marker's date comes from the phone's wall clock and is for display only.
"""
import datetime as dt

from app.ledger.events import Event, Kind, Source


def _markers(events: list[Event]) -> list[Event]:
    return [e for e in events if e.kind == Kind.day_start]


def _seen(e: Event, marker: Event) -> bool:
    return e.vclock.get(marker.device_id, 0) >= marker.seq


def day_of(e: Event, markers: list[Event]) -> int:
    return max((m.payload["index"] for m in markers if _seen(e, m)), default=0)


def day_of_events(events: list[Event]) -> dict[str, int]:
    markers = _markers(events)
    return {e.id: day_of(e, markers) for e in events}


def current_day(events: list[Event]) -> int:
    return max((m.payload["index"] for m in _markers(events)), default=0)


def in_day(events: list[Event], index: int) -> list[Event]:
    """Events filed in business day `index` (works on fused events too: their vector clock is merged)."""
    markers = _markers(events)
    return [e for e in events if day_of(e, markers) == index]


def start_day(store) -> Event:
    """Append the marker of the next business day (1 + the newest day this phone knows)."""
    with store._lock:                       # read-then-append atomically, like local sequence numbers
        index = current_day(store.all()) + 1
        date = dt.datetime.fromtimestamp(store.wall_clock()).date().isoformat()
        return store.append_local(Kind.day_start, Source.manual, [], payload={"index": index, "date": date},
                                  raw=f"start of day {index}")


def _suspect(date: str | None) -> bool:
    return date is not None and not (2000 <= int(date[:4]) <= 2090)


def list_days(events: list[Event]) -> list[dict]:
    markers = _markers(events)
    counts: dict[int, int] = {}
    for e in events:
        if e.kind != Kind.day_start:
            d = day_of(e, markers)
            counts[d] = counts.get(d, 0) + 1
    out = {0: {"index": 0, "date": None, "started_by": [], "clock_suspect": False}}
    for m in sorted(markers, key=lambda m: (m.payload["index"], m.device_id)):
        d = out.setdefault(m.payload["index"], {"index": m.payload["index"], "date": m.payload.get("date"),
                                                "started_by": [], "clock_suspect": False})
        d["started_by"].append(m.device_id)
        d["clock_suspect"] = d["clock_suspect"] or _suspect(m.payload.get("date"))
    for i in counts:
        out.setdefault(i, {"index": i, "date": None, "started_by": [], "clock_suspect": False})
    return [{**d, "events": counts.get(i, 0)} for i, d in sorted(out.items())]
