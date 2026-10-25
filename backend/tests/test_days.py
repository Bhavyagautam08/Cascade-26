"""Business days (A2): a day is opened by a `day_start` event, and an event belongs to the newest day
start it had SEEN (vector clock), never to a wall-clock date. History is kept; views scope to a day."""
from fastapi.testclient import TestClient

from app.ledger import days
from app.ledger.doubleentry import postings_for
from app.ledger.events import CandidateEvent, Kind, Source
from app.ledger.store import EventStore
from app.sync.clock import wall_clock


def _trade(s: EventStore, kind: Kind, item: str | None = None, amount: float | None = None, party=None, qty=None,
           unit=None):
    c = CandidateEvent(kind=kind, source=Source.manual, confidence=1.0, item=item, amount_rupees=amount,
                       party=party, qty=qty, unit=unit)
    return s.append_local(kind, Source.manual, postings_for(c),
                          payload=c.model_dump(exclude={"kind", "source", "raw", "confidence"}))


def test_events_before_any_day_start_are_day_zero_and_new_events_join_the_new_day(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-1")
    old = _trade(s, Kind.sale, "poha", 40)
    m = days.start_day(s)
    new = _trade(s, Kind.sale, "poha", 60)
    of = days.day_of_events(s.all())
    assert (of[old.id], of[m.id], of[new.id]) == (0, 1, 1)
    assert days.current_day(s.all()) == 1
    assert [d["index"] for d in days.list_days(s.all())] == [0, 1]


def test_a_broken_phone_clock_does_not_move_events_between_days(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-3", wall_clock("1970"))
    a = _trade(s, Kind.sale, "poha", 40)
    days.start_day(s)
    b = _trade(s, Kind.sale, "poha", 60)
    of = days.day_of_events(s.all())
    assert (of[a.id], of[b.id]) == (0, 1)                                    # causality, not the 1970 clock


def test_a_phone_joins_the_new_day_when_it_hears_of_it_and_all_phones_agree(tmp_path):
    p1, p2 = EventStore(tmp_path / "1.db", "phone-1"), EventStore(tmp_path / "2.db", "phone-2")
    days.start_day(p1)
    before_sync = _trade(p2, Kind.sale, "chai", 10)                         # phone-2 hasn't heard yet
    p2.ingest(p1.all())
    after_sync = _trade(p2, Kind.sale, "chai", 20)
    p1.ingest(p2.all())
    of1, of2 = days.day_of_events(p1.all()), days.day_of_events(p2.all())
    assert of1 == of2                                                        # same answer on every phone
    assert (of2[before_sync.id], of2[after_sync.id]) == (0, 1)


def test_two_phones_starting_the_day_concurrently_start_the_same_day(tmp_path):
    p1, p2 = EventStore(tmp_path / "1.db", "phone-1"), EventStore(tmp_path / "2.db", "phone-2")
    m1, m2 = days.start_day(p1), days.start_day(p2)
    p1.ingest(p2.all())
    assert m1.payload["index"] == m2.payload["index"] == 1
    assert [d["index"] for d in days.list_days(p1.all())] == [0, 1]


def test_day_label_comes_from_the_phone_but_is_display_only(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-3", wall_clock("1970"))
    m = days.start_day(s)
    assert m.payload["date"].startswith("1970")                              # shown, flagged by the UI, never used
    assert days.list_days(s.all())[-1]["clock_suspect"] is True


# --- through the API -------------------------------------------------------------------------------
def test_new_day_keeps_history_scopes_today_and_carries_udhaar_and_books():
    from app.main import app
    c = TestClient(app)
    c.post("/day/new", json={"confirm": True})                                # isolate from earlier tests
    c.post("/ingest/text", json={"text": "kamal ji ka 70 udhaar likh", "engine": "rules"})
    c.post("/ingest/text", json={"text": "5 plate poha becha 100", "engine": "rules"})
    before = c.get("/ledger/summary").json()
    assert before["profit"]["components"]["revenue"] > 0

    r = c.post("/day/new", json={"confirm": True}).json()
    assert r["day"]["index"] == before["day"]["index"] + 1
    after = c.get("/ledger/summary").json()
    assert after["day"]["index"] == r["day"]["index"] and after["day"]["current"]
    assert after["profit"]["components"]["revenue"] == 0                     # today starts fresh
    assert after["receivables"]["kamal"] == 70                               # a debt does not vanish overnight
    assert after["balances_paise"] == before["balances_paise"]               # the books are cumulative
    old_day = c.get(f"/ledger/summary?day={before['day']['index']}").json()
    assert old_day["profit"]["components"]["revenue"] > 0                    # history still there
    evs = c.get("/events").json()
    assert {e["day"] for e in evs} >= {before["day"]["index"], r["day"]["index"]}


def test_unknown_day_is_a_clear_error():
    from app.main import app
    c = TestClient(app)
    assert c.get("/ledger/summary?day=9999").status_code == 404
    assert c.post("/day/new", json={}).status_code == 422
