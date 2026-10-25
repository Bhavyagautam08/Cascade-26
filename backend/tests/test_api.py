"""End-to-end through the HTTP API in MODEL_MODE=demo (see conftest.py): same code path the UI uses."""
import threading

from fastapi.testclient import TestClient

from app.ledger.doubleentry import postings_for
from app.ledger.events import Source
from app.ledger.store import EventStore, causal_order
from app.main import app
from app.perception import rules
from app.sync.clock import wall_clock

client = TestClient(app)
PS_SENTENCE = "Bhai 3 kilo tamatar liya 180 mein… Sharma ji ka 40 jama kar, aur 7 plate poha de."


def _bal() -> dict[str, int]:
    return client.get("/ledger/balances").json()["balances_paise"]


def test_health_reports_demo_mode():
    h = client.get("/health").json()
    assert h["device_id"] == "phone-1" and h["model_mode"] == "demo"


def test_text_through_demo_extractor():
    r = client.post("/ingest/text", json={"text": PS_SENTENCE, "source": "sms"}).json()
    assert r["engine"] == "demo"
    assert [e["kind"] for e in r["events"]] == ["purchase", "credit_paid", "sale"]
    assert client.get("/ledger/balances").json()["balanced"]


def test_simulated_voice_feeds_transcripts_and_scales_confidence():
    r = client.post("/mic/simulate", json={"text": "2 kilo pyaz laya 80", "confidence": 0.5}).json()
    assert r["events"][0]["confidence"] == 0.375          # rules 0.75 x heard 0.5
    assert client.get("/mic/recent").json()[-1]["text"] == "2 kilo pyaz laya 80"


def test_slip_read_then_confirm():
    slip = client.post("/ingest/slip", files={"file": ("slip.jpg", b"\xff\xd8fake", "image/jpeg")}).json()
    assert slip["reader"] == "demo" and min(l["confidence"] for l in slip["lines"]) < 0.5
    before = _bal().get("inventory:tomato", 0)
    lines = [{**l, "confidence": 1.0} for l in slip["lines"] if l["amount_rupees"] is not None]
    out = client.post("/ingest/slip/confirm", json={"supplier": slip["supplier"], "lines": lines}).json()
    assert len(out["events"]) == 3
    assert _bal()["inventory:tomato"] - before == 30000


def test_conflict_resolution_clears_suspense(tmp_path):
    client.post("/ingest/text", json={"text": "rahul ji ka 40 jama", "source": "voice", "engine": "rules"})
    other = EventStore(tmp_path / "p2.db", "phone-2")                       # a concurrent family phone
    for c in rules.parse("rahul ji ka 400 jama", client.get("/lexicon").json(), Source.tally):
        other.append_local(c.kind, c.source, postings_for(c), payload=c.model_dump(exclude={"kind", "source"}),
                           confidence=c.confidence)
    client.post("/sync/push", json={"events": [e.model_dump(mode="json") for e in other.all()]})

    summary = client.get("/ledger/summary").json()
    conflict = next(c for c in summary["conflicts"] if c["party"] == "rahul")
    assert conflict["suspense_paise"] == 36000 and summary["balanced"]

    client.post("/ledger/resolve", json={"ids": conflict["ids"], "amount_rupees": 40})
    summary = client.get("/ledger/summary").json()
    assert not any(c["party"] == "rahul" for c in summary["conflicts"])
    assert summary["balances_paise"].get("suspense", 0) == 0
    assert summary["balances_paise"]["receivable:rahul"] == -4000
    assert summary["balanced"]


def test_void_stops_an_entry_counting():
    ev = client.post("/ingest/text", json={"text": "9 plate poha de", "engine": "rules"}).json()["events"][0]
    cash = _bal()["cash"]
    client.post("/ledger/void", json={"id": ev["id"]})
    assert cash - _bal()["cash"] == 18000
    assert client.post("/ledger/void", json={"id": "nope:1"}).status_code == 404


def test_lexicon_drop_list_section_and_unit():
    lex = client.post("/lexicon", json={"section": "perishable", "key": "onion"}).json()
    assert "onion" in lex["perishable"]
    client.post("/lexicon", json={"section": "units", "key": "peti", "value": {"unit": "kg", "factor": 20}})
    r = client.post("/ingest/text", json={"text": "2 peti kanda liya 300", "engine": "rules"}).json()
    assert r["events"][0]["payload"]["qty"] == 40


def test_hostile_clocks_are_far_from_now_and_ignored_for_order(tmp_path):
    assert wall_clock("1970")() < 86_400
    s = EventStore(tmp_path / "h.db", "phone-3", wall_clock("jump"))
    evs = [s.append_local(**dict(kind="sale", source="manual", postings=[])) for _ in range(5)]
    assert [e.id for e in causal_order(list(reversed(evs)))] == [e.id for e in evs]


def test_concurrent_local_appends_never_lose_events(tmp_path):
    s = EventStore(tmp_path / "c.db", "phone-1")

    def burst():
        for _ in range(25):
            s.append_local(kind="sale", source="voice", postings=[])

    threads = [threading.Thread(target=burst) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(e.seq for e in s.all()) == list(range(1, 201))


def test_slip_confirm_priced_unreadable_and_order_lines():
    priced = client.post("/ingest/slip/confirm", json={"supplier": None, "lines": [
        {"item": "paneer", "qty": 0.5, "unit": "kg", "amount_rupees": 320, "confidence": 1.0},
        {"item": "oil", "qty": 0.1, "unit": "l", "amount_rupees": None, "confidence": 1.0}]}).json()["events"]
    assert [e["kind"] for e in priced] == ["purchase", "purchase"]          # missing price on a priced bill
    assert "amount_unreadable" in priced[1]["payload"]["flags"]
    listed = client.post("/ingest/slip/confirm", json={"supplier": None, "lines": [
        {"item": "rice", "qty": 0.2, "unit": "kg", "amount_rupees": None, "confidence": 1.0}]}).json()["events"]
    assert listed[0]["kind"] == "order" and listed[0]["postings"] == []      # a price-less list: recorded, books nothing


def test_same_trade_heard_twice_is_booked_once_but_can_be_forced(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "voice_repeat_window_s", 60.0)
    first = client.post("/mic/simulate", json={"text": "4 kilo aloo liya 120 mein", "confidence": 0.9}).json()
    again = client.post("/mic/simulate", json={"text": "4 kilo aloo liya 120 mein", "confidence": 0.9}).json()
    assert len(first["events"]) == 1 and again["events"] == []
    assert again["repeats"][0]["of"] == first["events"][0]["id"]
    assert client.get("/mic/recent").json()[-1]["repeats"] == 1
    forced = client.post("/ingest/text", json={"text": "4 kilo aloo liya 120 mein", "source": "voice"}).json()
    assert len(forced["events"]) == 1            # "book it anyway": typed path never drops repeats


def test_too_unclear_speech_is_shown_not_booked():
    r = client.post("/mic/simulate", json={"text": "bhaj kilo kanda", "confidence": 0.08}).json()
    assert r["events"] == [] and r["held"]
    assert client.get("/mic/recent").json()[-1]["held"]
