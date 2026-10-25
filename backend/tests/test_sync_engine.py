"""The sync conversation (app/sync/protocol.py) and the engine that runs it by itself (app/sync/engine.py),
driven with in-process peers that speak exactly the wire format (JSON round trip)."""
import json
import threading
import time

import pytest

from app.ledger.doubleentry import balances
from app.ledger.events import Kind, Posting, Source
from app.ledger.fusion import fuse
from app.ledger.store import EventStore
from app.sync import protocol
from app.sync.engine import SyncEngine


class Wire:
    """A peer reached in-process. Everything crosses as JSON, like over HTTP; can be carried out of range."""

    def __init__(self, store: EventStore, url: str | None = None):
        self.store, self.url, self.reachable, self.calls = store, url or f"local://{store.name}", True, 0
        self.instance = protocol.new_instance()

    def _go(self, fn, *args):
        if not self.reachable:
            raise protocol.Unreachable(f"{self.url} is out of range")
        self.calls += 1
        return json.loads(json.dumps(fn(self.store, *json.loads(json.dumps(args)), **({"instance": self.instance}
                                                                                       if fn is protocol.hello else {}))))

    def hello(self):
        return self._go(protocol.hello)

    def pull(self, have, after, limit):
        return self._go(protocol.pull, have, after, limit)

    def push(self, events):
        return self._go(protocol.push, events)


def _phone(tmp_path, name):
    return EventStore.open(tmp_path / f"{name}.db", name)


def _sale(store, rupees=10):
    amt = rupees * 100
    return store.append_local(Kind.sale, Source.manual,
                              [Posting(account="cash", amount=amt), Posting(account="revenue:sales", amount=-amt)])


def _ids(store):
    return {e.id for e in store.all()}


# --- one exchange ------------------------------------------------------------------------------
def test_one_exchange_moves_everything_both_ways_in_pages(tmp_path):
    a, b = _phone(tmp_path, "phone-1"), _phone(tmp_path, "phone-2")
    for i in range(5):
        _sale(a, 10 + i)
    for i in range(3):
        _sale(b, 50 + i)
    rep = protocol.exchange(a, Wire(b), page=2)
    assert (rep["pulled"], rep["pushed"], rep["rejected"]) == (3, 5, [])
    assert (rep["peer_name"], rep["peer_actor"]) == ("phone-2", b.device_id)
    assert _ids(a) == _ids(b) and len(_ids(a)) == 8
    again = protocol.exchange(a, Wire(b), page=2)
    assert (again["pulled"], again["pushed"]) == (0, 0)              # repeating adds nothing


def test_a_cut_off_exchange_loses_nothing_and_resumes(tmp_path):
    a, b = _phone(tmp_path, "phone-1"), _phone(tmp_path, "phone-2")
    for _ in range(6):
        _sale(b)
    w = Wire(b)
    real_pull = w.pull

    def pull_then_drop(*args):
        out = real_pull(*args)
        w.reachable = False                                          # walks out of range after one page
        return out

    w.pull = pull_then_drop
    with pytest.raises(protocol.Unreachable):
        protocol.exchange(a, w, page=2)
    assert len(a.all()) == 2                                         # the first page is kept
    w.pull, w.reachable = real_pull, True
    assert protocol.exchange(a, w, page=2)["pulled"] == 4 and _ids(a) == _ids(b)


def test_a_bad_entry_from_a_peer_is_reported_and_the_rest_still_arrives(tmp_path):
    a, b = _phone(tmp_path, "phone-1"), _phone(tmp_path, "phone-2")
    evs = [_sale(b) for _ in range(3)]
    w = Wire(b)
    real_pull = w.pull

    def poisoned(*args):
        out = real_pull(*args)
        for e in out["events"]:
            if e["id"] == evs[1].id:
                e["postings"][0]["amount"] += 1                      # unbalanced: not a valid entry
        return out

    w.pull = poisoned
    rep = protocol.exchange(a, w, page=10)
    assert rep["pulled"] == 2
    assert [r["id"] for r in rep["rejected"]] == [evs[1].id] and "not a valid entry" in rep["rejected"][0]["reason"]


def test_a_peer_writing_as_our_actor_makes_us_switch_before_writing(tmp_path):
    a = _phone(tmp_path, "phone-1")
    a.db.close()
    (tmp_path / "copy.db").write_bytes((tmp_path / "phone-1.db").read_bytes())
    a, twin = EventStore.open(tmp_path / "phone-1.db", "phone-1"), EventStore.open(tmp_path / "copy.db", "phone-1")
    old = a.device_id
    rep = protocol.exchange(a, Wire(twin))
    assert rep["rotated"] and rep["rotated"][0]["from"] == old and a.device_id != old
    assert any("phone-1" in w for w in rep["warnings"])               # two devices with one name
    assert _sale(a).id != _sale(twin).id                              # no clash any more


def test_a_device_listed_as_its_own_peer_is_refused_not_rotated_forever(tmp_path):
    a = _phone(tmp_path, "phone-1")
    me = Wire(a)
    me.instance = protocol.INSTANCE                                   # it is this very process
    with pytest.raises(protocol.ProtocolError, match="itself"):
        protocol.exchange(a, me)
    assert a.device_id == a.get_meta("actor")


def test_relay_through_a_third_phone(tmp_path):
    a, b, c = (_phone(tmp_path, n) for n in ("phone-1", "phone-2", "phone-3"))
    x = _sale(a, 40)
    protocol.exchange(b, Wire(a))                                     # a and c never meet
    protocol.exchange(c, Wire(b))
    assert x.id in _ids(c)


# --- the engine ---------------------------------------------------------------------------------
def _family(tmp_path, n=3, **kw):
    stores = [_phone(tmp_path, f"phone-{i + 1}") for i in range(n)]
    wires = {s.name: Wire(s) for s in stores}
    engines = [SyncEngine(s, [wires[o.name] for o in stores if o is not s], **kw) for s in stores]
    return stores, wires, engines


def test_engine_reports_an_absent_phone_and_catches_up_when_it_returns(tmp_path):
    (a, b, c), wires, (ea, eb, ec) = _family(tmp_path, interval_s=0)
    wires["phone-2"].reachable = False                                # phone-2 goes to the mandi
    _sale(a, 20)
    _sale(b, 80)                                                      # recorded while away
    ea.run_once()
    st = {p["url"]: p for p in ea.status()["peers"]}
    away = st[wires["phone-2"].url]
    assert away["state"] == "unreachable" and "out of range" in away["last_error"]
    assert away["failures_in_a_row"] == 1 and st[wires["phone-3"].url]["state"] == "ok"
    wires["phone-2"].reachable = True                                 # back at the stall
    eb.run_once()
    ea.run_once()
    ec.run_once()
    assert _ids(a) == _ids(b) == _ids(c) and len(_ids(a)) == 2
    back = {p["url"]: p for p in ea.status()["peers"]}[wires["phone-2"].url]
    assert back["state"] == "ok" and back["failures_in_a_row"] == 0 and back["last_error"] is None
    assert back["name"] == "phone-2" and back["actor"] == b.device_id


def test_engine_keeps_a_refusal_visible(tmp_path):
    (a, b), wires, (ea, _) = _family(tmp_path, n=2, interval_s=0)

    def refuse(*_):
        raise protocol.PeerRefused("401: sync key missing or wrong")

    wires["phone-2"].hello = refuse
    res = ea.run_once()
    assert res[wires["phone-2"].url]["error"] == "401: sync key missing or wrong"
    assert ea.status()["peers"][0]["state"] == "refused"


def test_a_bug_in_a_round_is_reported_not_swallowed(tmp_path, caplog):
    (a, b), wires, (ea, _) = _family(tmp_path, n=2, interval_s=0)

    def broken(*_):
        raise KeyError("our own bug")

    wires["phone-2"].hello = broken
    res = ea.run_once()
    assert "KeyError" in res[wires["phone-2"].url]["error"] and ea.status()["peers"][0]["state"] == "error"
    assert "our own bug" in caplog.text                               # logged with its traceback


def test_engine_syncs_by_itself_and_wakes_up_on_a_new_entry(tmp_path):
    (a, b, c), wires, engines = _family(tmp_path, interval_s=30, min_gap_s=0.05)   # long interval: only wake-ups
    for e in engines:
        e.start()
    try:
        x = _sale(a, 30)
        deadline = time.monotonic() + 5
        while not (x.id in _ids(b) and x.id in _ids(c)) and time.monotonic() < deadline:
            time.sleep(0.02)
        assert x.id in _ids(b) and x.id in _ids(c)
        assert all(e.status()["running"] for e in engines)
    finally:
        for e in engines:
            e.stop()
    assert not any(e.status()["running"] for e in engines)


def test_rounds_never_overlap(tmp_path):
    (a, b), wires, (ea, _) = _family(tmp_path, n=2, interval_s=0)
    inside, most = [0], [0]
    real = wires["phone-2"].hello

    def slow_hello():
        inside[0] += 1
        most[0] = max(most[0], inside[0])
        time.sleep(0.05)
        inside[0] -= 1
        return real()

    wires["phone-2"].hello = slow_hello
    ts = [threading.Thread(target=ea.run_once) for _ in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert most[0] == 1


def test_everyone_computes_the_same_books_after_a_partition(tmp_path):
    (a, b, c), wires, engines = _family(tmp_path, interval_s=0)
    for w in wires.values():
        w.reachable = False                                           # nobody can reach anybody
    _sale(a, 10)
    _sale(b, 20)
    _sale(c, 30)
    for e in engines:
        e.run_once()
    for w in wires.values():
        w.reachable = True
    for _ in range(2):
        for e in engines:
            e.run_once()
    books = [balances(fuse(s.all()).effective) for s in (a, b, c)]
    assert books[0] == books[1] == books[2] and books[0]["cash"] == 6000
