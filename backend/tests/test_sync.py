import random

import pytest

from app.ledger.doubleentry import trial_balance_ok
from app.ledger.events import Kind, Posting, Source
from app.ledger.store import EventStore, causal_order


def _sale(store: EventStore, rupees: int):
    amt = rupees * 100
    return store.append_local(
        Kind.sale, Source.manual,
        [Posting(account="cash", amount=amt), Posting(account="revenue:sales", amount=-amt)],
    )


def test_merge_is_order_independent_and_balanced(tmp_path):
    a = EventStore(tmp_path / "a.db", "a")
    b = EventStore(tmp_path / "b.db", "b")
    c = EventStore(tmp_path / "c.db", "c")
    for s, n in ((a, 3), (b, 2), (c, 4)):
        for i in range(n):
            _sale(s, 10 + i)

    everything = a.all() + b.all() + c.all()
    x = EventStore(tmp_path / "x.db", "x")
    y = EventStore(tmp_path / "y.db", "y")
    x.ingest(everything)
    shuffled = everything[:]
    random.shuffle(shuffled)
    y.ingest(shuffled + shuffled)  # duplicates are ignored

    assert [e.id for e in causal_order(x.all())] == [e.id for e in causal_order(y.all())]
    assert len(y.all()) == 9
    assert trial_balance_ok(y.all())


# The hostile-clock test lives in test_faults.py (test_F7_...): the old one here could not fail.


# --- what a peer holds, and sending exactly what it lacks ---------------------------------------
def test_have_describes_held_entries_beyond_a_gap(tmp_path):
    a, b = EventStore(tmp_path / "a.db", "a"), EventStore(tmp_path / "b.db", "b")
    evs = [_sale(a, 10) for _ in range(5)]
    b.ingest([evs[0], evs[1], evs[3]])
    assert b.have() == {"a": [[1, 2], [4, 4]]}
    assert b.frontier() == {"a": 2}                       # the vector clock still claims only the gap-free part
    page, more = a.missing(b.have())
    assert [e.id for e in page] == ["a:3", "a:5"] and more is False   # a:4 is not sent again


def test_pages_come_in_order_and_the_cursor_always_moves_forward(tmp_path):
    a, b, c = (EventStore(tmp_path / f"{n}.db", n) for n in "abc")
    for _ in range(4):
        _sale(a, 10)
    for _ in range(3):
        _sale(b, 20)
    c.ingest(a.all() + b.all())
    got, after = [], None
    while True:
        page, more = c.missing({}, after=after, limit=3)
        got += [e.id for e in page]
        if not more:
            break
        after = (page[-1].device_id, page[-1].seq)
    assert got == ["a:1", "a:2", "a:3", "a:4", "b:1", "b:2", "b:3"]


def test_a_refused_entry_cannot_stall_paging(tmp_path):
    """A peer that keeps refusing one entry still receives everything after it."""
    a, b = EventStore(tmp_path / "a.db", "a"), EventStore(tmp_path / "b.db", "b")
    evs = [_sale(a, 10) for _ in range(6)]
    b.ingest([evs[1].model_copy(update={"raw": "someone else's version"})])   # b holds a different a:2
    received, after = [], None
    while True:
        page, more = a.missing({"a": []}, after=after, limit=2)               # a pretends b holds nothing
        res = b.ingest(page)
        received += [e.id for e in page]
        if not more:
            break
        after = (page[-1].device_id, page[-1].seq)
    assert received == [e.id for e in evs]
    assert {e.id for e in b.all()} == {e.id for e in evs}
    assert res.rejected == [] and len(b.all()) == 6


def test_missing_for_a_frontier_still_works(tmp_path):
    a, b = EventStore(tmp_path / "a.db", "a"), EventStore(tmp_path / "b.db", "b")
    evs = [_sale(a, 10) for _ in range(3)]
    b.ingest([evs[0]])
    assert [e.id for e in a.missing_for(b.frontier())] == ["a:2", "a:3"]


def test_ingest_is_all_or_nothing(tmp_path, monkeypatch):
    a, b = EventStore(tmp_path / "a.db", "a"), EventStore(tmp_path / "b.db", "b")
    evs = [_sale(a, 10) for _ in range(3)]
    real = b._insert
    calls = {"n": 0}

    def failing(ev, commit=True):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("disk full")
        return real(ev, commit=commit)

    monkeypatch.setattr(b, "_insert", failing)
    with pytest.raises(OSError, match="disk full"):
        b.ingest(evs)
    monkeypatch.undo()
    assert b.all() == []                                  # nothing half-written
    assert b.ingest(evs).added == 3


def test_malformed_ids_are_refused(tmp_path):
    a, b = EventStore(tmp_path / "a.db", "a"), EventStore(tmp_path / "b.db", "b")
    ev = _sale(a, 10)
    bad = [ev.model_copy(update={"device_id": "a:x", "id": "a:x:1"}),
           ev.model_copy(update={"device_id": "", "id": ":1", "vclock": {"": 1}})]
    res = b.ingest(bad)
    assert res.added == 0 and len(res.rejected) == 2


# --- listeners: the sync engine wakes when the book changes -----------------------------------
def test_listeners_fire_on_local_entries_and_on_new_entries_from_peers(tmp_path):
    a, b = EventStore(tmp_path / "a.db", "a"), EventStore(tmp_path / "b.db", "b")
    heard = []
    b.listeners.append(heard.append)
    ev = _sale(a, 10)
    b.ingest([ev])
    b.ingest([ev])                                        # nothing new: no wake-up
    _sale(b, 20)
    assert heard == ["ingest", "local"]


def test_meta_survives_reopening(tmp_path):
    s = EventStore(tmp_path / "a.db", "a")
    assert s.get_meta("name") is None
    s.set_meta("name", "a")
    s.db.close()
    assert EventStore(tmp_path / "a.db", "a").get_meta("name") == "a"
