import random

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


def test_wall_clock_jump_does_not_reorder(tmp_path):
    a = EventStore(tmp_path / "a.db", "a")
    first = _sale(a, 10)
    second = _sale(a, 20)
    second.wall_time = 0.0  # device "reset to 1970"
    order = [e.id for e in causal_order([second, first])]
    assert order == [first.id, second.id]
