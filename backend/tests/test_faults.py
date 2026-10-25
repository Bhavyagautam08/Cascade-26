"""Regression tests for the codebase audit: each test names the finding it pins down."""
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app import pipeline
from app.config import settings
from app.ledger import inference
from app.ledger.doubleentry import balances, incomplete, postings_for, trial_balance_ok
from app.ledger.events import CandidateEvent, Kind, Posting, Source
from app.ledger.fusion import fuse
from app.ledger.store import EventStore, causal_order
from app.main import app
from app.perception import rules, sms
from app.perception.extractor import Extraction

LEX = json.loads((Path(__file__).parent.parent / "data" / "lexicon.json").read_text(encoding="utf-8"))
client = TestClient(app)


def _add(store: EventStore, text: str, source: Source):
    out = []
    for c in rules.parse(text, LEX, source):
        out.append(store.append_local(c.kind, c.source, postings_for(c),
                                      payload=c.model_dump(exclude={"kind", "source", "raw", "confidence"}),
                                      confidence=c.confidence, raw=c.raw))
    return out


def _one(text: str) -> CandidateEvent:
    evs = rules.parse(text, LEX)
    assert len(evs) == 1, evs
    return evs[0]


# --- A: wrong outputs -------------------------------------------------------------------------
def test_A1_number_word_used_as_verb_is_not_money():
    e = _one("5 plate poha de do")
    assert e.amount_rupees == 100 and "priced_from_list" in e.flags     # 5 x Rs20, flagged, never Rs2
    assert e.confidence <= rules.CONF_PRICED_FROM_LIST


def test_A2_time_of_day_is_not_money():
    assert _one("7 plate poha de 2 baje").amount_rupees == 140            # priced, not Rs2
    assert _one("3 plate poha 60 mein becha 2 baje").amount_rupees == 60


def test_A2_two_unmarked_numbers_leave_the_amount_unknown():
    e = _one("chai 10 de 20")
    assert e.amount_rupees is None and "ambiguous_amount" in e.flags


def test_A3_A5_bank_sms_directions():
    assert sms.parse("Rs.140 credited to your a/c XX1234 from CHHOTU via UPI").direction == "in"
    assert sms.parse("Rs 140 received from Sharma via UPI").party == "sharma"
    t = sms.parse("INR 250.00 debited for Gupta Traders")
    assert (t.direction, t.amount_rupees, t.party) == ("out", 250.0, "gupta traders")
    assert sms.parse("7 plate poha becha 140") is None
    assert not any(e.kind == Kind.credit_given for e in rules.parse("chhotu 140", LEX))   # no verb: no guessed udhaar


def test_A3_bank_inflow_from_a_debtor_is_repayment_else_suspense():
    client.post("/ingest/text", json={"text": "meena ji ka 90 udhaar", "engine": "rules"})
    r = client.post("/ingest/text", json={"text": "Rs 90 received from MEENA via UPI", "source": "sms"}).json()
    assert r["engine"] == "bank_sms" and r["events"][0]["kind"] == "credit_paid"
    r = client.post("/ingest/text", json={"text": "Rs 55 received from STRANGER via UPI", "source": "sms"}).json()
    ev = r["events"][0]
    assert ev["kind"] == "adjustment" and {"account": "suspense", "amount": -5500} in ev["postings"]


def test_A4_clause_without_verb_inherits_or_is_reported():
    evs = rules.parse("2 kilo pyaz laya 80 aur 1 kilo aloo 30", LEX)
    assert [(e.item, e.amount_rupees) for e in evs] == [("onion", 80), ("potato", 30)]
    assert "verb_inherited" in evs[1].flags
    r = client.post("/ingest/text", json={"text": "1 kilo aloo 30", "engine": "rules"}).json()
    assert r["events"] == [] and r["unparsed"] == ["1 kilo aloo 30"]


def test_A6_money_handed_to_a_person_is_not_a_sale():
    e = _one("sharma ji ko 50 diya")
    assert e.kind == Kind.adjustment and e.direction == "out" and e.party == "sharma"
    assert {p.account for p in postings_for(e)} == {"suspense", "cash"}


def test_A7_unrelated_concurrent_payments_both_count(tmp_path):
    a, b = EventStore(tmp_path / "a.db", "phone-1"), EventStore(tmp_path / "b.db", "phone-2")
    _add(a, "sharma ji ka 40 jama", Source.voice)
    _add(b, "sharma ji ka 60 jama", Source.tally)
    a.ingest(b.all())
    rep = fuse(a.all())
    assert rep.conflicts == [] and len(rep.possible_conflicts) == 1
    assert balances(rep.effective)["cash"] == 10000


def test_A7_misheard_dispute_can_be_marked_separate(tmp_path):
    a, b = EventStore(tmp_path / "a.db", "phone-1"), EventStore(tmp_path / "b.db", "phone-2")
    x = _add(a, "sharma ji ka 40 jama", Source.voice)[0]
    y = _add(b, "sharma ji ka 400 jama", Source.tally)[0]
    a.ingest(b.all())
    assert len(fuse(a.all()).conflicts) == 1
    a.append_local(Kind.adjustment, Source.manual, [], payload={"separate": [x.id, y.id]})
    rep = fuse(a.all())
    assert rep.conflicts == [] and balances(rep.effective)["cash"] == 44000


def test_A8_only_identical_trades_merge_and_humans_can_split(tmp_path):
    s = EventStore(tmp_path / "a.db", "a")
    v = _add(s, "7 plate poha de 140", Source.voice)[0]
    m = _add(s, "7 plate poha becha 140", Source.sms)[0]
    _add(s, "7 plate poha becha 150", Source.tally)                 # different amount: separate sale
    rep = fuse(s.all())
    assert rep.duplicates == [[v.id, m.id]] and balances(rep.effective)["cash"] == 29000
    s.append_local(Kind.adjustment, Source.manual, [], payload={"separate": [v.id, m.id]})
    assert balances(fuse(s.all()).effective)["cash"] == 43000


def test_A9_mic_echo_counts_once_but_two_real_sales_count_twice(tmp_path):
    s = EventStore(tmp_path / "a.db", "a")
    _add(s, "7 plate poha de 140", Source.voice)
    _add(s, "7 plate poha de 140", Source.voice)                    # same words, back to back: echo
    assert balances(fuse(s.all()).effective)["cash"] == 14000
    _add(s, "5 kilo tamatar bacha", Source.voice)
    _add(s, "7 plate poha de 140", Source.voice)                    # later, not adjacent: a new sale
    assert balances(fuse(s.all()).effective)["cash"] == 28000


# --- B: claims now implemented ----------------------------------------------------------------
class _FakeLLM:
    name = "fake-llm"

    def __init__(self, events):
        self.events = events

    def from_text(self, text, source):
        return Extraction(is_transaction=True, events=[e.model_copy(deep=True) for e in self.events])


def test_B1_llm_amounts_not_in_text_are_removed(monkeypatch):
    invented = CandidateEvent(kind=Kind.sale, source=Source.voice, confidence=0.99, item="poha", qty=3,
                              amount_rupees=999)
    monkeypatch.setattr(pipeline, "extractor", lambda: _FakeLLM([invented]))
    monkeypatch.setattr(settings, "model_mode", "real")
    r = client.post("/ingest/text", json={"text": "3 plate poha becha 75", "engine": "llm"}).json()
    ev = r["events"][0]
    assert ev["payload"]["amount_rupees"] is None and ev["postings"] == []
    assert ev["confidence"] <= rules.CONF_NO_AMOUNT and r["cross_check"]["amounts_removed"] == 1
    assert r["cross_check"]["agree"] is False


def test_B1_llm_confidence_is_capped(monkeypatch):
    honest = CandidateEvent(kind=Kind.sale, source=Source.voice, confidence=0.99, item="poha", amount_rupees=75)
    monkeypatch.setattr(pipeline, "extractor", lambda: _FakeLLM([honest]))
    monkeypatch.setattr(settings, "model_mode", "real")
    r = client.post("/ingest/text", json={"text": "3 plate poha becha 75", "engine": "llm"}).json()
    assert r["events"][0]["confidence"] == settings.llm_max_confidence


def test_D1_D5_fallback_says_why_and_bugs_are_not_masked(monkeypatch):
    class Down:
        name = "x"

        def from_text(self, *_):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(pipeline, "extractor", lambda: Down())
    r = client.post("/ingest/text", json={"text": "5 cup chai de", "engine": "auto"}).json()
    assert r["engine"] == "rules" and "Ollama is not running" in r["fallback_reason"]
    assert client.post("/ingest/text", json={"text": "5 cup chai de", "engine": "llm"}).status_code == 503

    class Buggy:
        name = "x"

        def from_text(self, *_):
            raise KeyError("our own bug")

    monkeypatch.setattr(pipeline, "extractor", lambda: Buggy())
    with pytest.raises(KeyError):                                    # not relabelled "model unavailable"
        client.post("/ingest/text", json={"text": "5 cup chai de", "engine": "auto"})


def test_B3_profit_uses_stock_counts_when_present(tmp_path):
    s = EventStore(tmp_path / "a.db", "a")
    _add(s, "10 kilo tamatar liya 300", Source.manual)
    p = inference.profit_range(fuse(s.all()).effective)
    assert p["cogs_method"] == {"tomato": "assumed_unsold_fraction"}
    _add(s, "4 kilo tamatar bacha", Source.manual)                  # 6 kg used at Rs30/kg = Rs180
    p = inference.profit_range(fuse(s.all()).effective)
    assert p["cogs_method"] == {"tomato": "stock_count"}
    assert 150 < p["components"]["cogs"] < 210
    assert p["assumptions"]["collection_beta"] == [8.0, 2.0]


def test_B3_B5_wastage_chain_runs_on_ledger_data(tmp_path):
    s = EventStore(tmp_path / "a.db", "a")
    _add(s, "10 kilo poha liya 400", Source.manual)
    _add(s, "10 kilo poha bacha", Source.manual)
    for plates, left in ((50, 5.8), (80, 3.0)):                     # 80 g/plate + ~0.2 kg waste per period
        _add(s, f"{plates} plate poha becha {plates * 20}", Source.manual)
        _add(s, f"{left} kilo poha bacha", Source.manual)
    out = inference.wastage_from_ledger(s.all(), ["tomato"])
    poha = out["ingredients"]["poha"]
    assert poha["status"] == "ok" and poha["periods"] == 2
    assert abs(poha["usage_per_dish"]["poha"] - 0.08) < 0.01
    assert "split" in poha["loss"] and "assumptions" in poha["loss"]


def test_B5_expense_and_stock_count_are_parseable():
    assert _one("gas ka 300 kharcha").kind == Kind.expense
    e = _one("5 kilo tamatar bacha")
    assert (e.kind, e.item, e.qty) == (Kind.stock_count, "tomato", 5.0)


def test_B9_ui_is_loopback_only_and_sync_needs_the_key(monkeypatch):
    monkeypatch.setattr(settings, "allow_remote_ui", False)
    assert client.get("/events").status_code == 403                 # TestClient isn't loopback
    monkeypatch.setattr(settings, "sync_key", "family-secret")
    assert client.get("/sync/frontier").status_code == 401
    assert client.get("/sync/frontier", headers={"X-Sync-Key": "family-secret"}).status_code == 200


# --- C8 / D: no fake accounts, nothing silently vanishes ----------------------------------------
def test_C8_unknowns_go_to_suspense_not_made_up_accounts():
    accts = {p.account for p in postings_for(CandidateEvent(kind=Kind.purchase, source=Source.manual,
                                                             confidence=1, amount_rupees=50))}
    assert accts == {"suspense", "cash"}


def test_D7_simulated_speech_is_not_voice_evidence():
    ev = client.post("/mic/simulate", json={"text": "2 kilo pyaz laya 80"}).json()["events"][0]
    assert ev["source"] == "manual" and "simulated_voice" in ev["payload"]["flags"]


def test_D8_D9_unreadable_slip_lines_are_kept_and_listed():
    r = client.post("/ingest/slip/confirm", json={"supplier": "x", "lines": [
        {"item": "oil", "qty": 2, "unit": "l", "amount_rupees": None, "confidence": 0.3}]}).json()
    eid = r["events"][0]["id"]
    assert eid in {i["id"] for i in client.get("/ledger/summary").json()["incomplete"]}


def test_correction_replaces_the_original():
    ev = client.post("/ingest/text", json={"text": "Rs 77 received from NOBODY via UPI", "source": "sms"}).json()["events"][0]
    before = client.get("/ledger/balances").json()["balances_paise"]
    client.post("/ledger/correct", json={"id": ev["id"], "kind": "sale", "item": "poha"})
    after = client.get("/ledger/balances").json()["balances_paise"]
    assert after.get("suspense", 0) - before.get("suspense", 0) == 7700          # left suspense...
    assert after["revenue:sales"] - before["revenue:sales"] == -7700             # ...became a sale


# --- E8 / F7: sync integrity and a clock test that can fail -------------------------------------
def test_E8_gaps_are_resent_and_forged_events_rejected(tmp_path):
    a, b = EventStore(tmp_path / "a.db", "a"), EventStore(tmp_path / "b.db", "b")
    evs = [a.append_local(Kind.sale, Source.manual, []) for _ in range(3)]
    res = b.ingest([evs[0], evs[2]])                                 # partial delivery: gap at a:2
    assert res.added == 2 and b.frontier() == {"a": 1}
    assert [e.id for e in a.missing_for(b.frontier())] == ["a:2", "a:3"]
    forged = evs[1].model_copy(update={"id": "a:99"})
    tampered = evs[0].model_copy(update={"raw": "changed"})
    res = b.ingest([forged, tampered])
    assert res.added == 0 and len(res.rejected) == 2


def test_F7_hostile_wall_clock_cannot_reorder_history(tmp_path):
    times = iter([2_000_000_000.0, 0.0, 4_070_908_800.0, 5.0])      # now, 1970, 2099, 1970
    s = EventStore(tmp_path / "h.db", "phone-3", wall_clock=lambda: next(times))
    evs = [s.append_local(Kind.sale, Source.manual, [Posting(account="cash", amount=100),
                                                     Posting(account="revenue:sales", amount=-100)])
           for _ in range(4)]
    by_wall = [e.id for e in sorted(evs, key=lambda e: e.wall_time)]
    assert by_wall != [e.id for e in evs]                              # the clock really is hostile...
    assert [e.id for e in causal_order(list(reversed(evs)))] == [e.id for e in evs]   # ...and ignored
    assert trial_balance_ok(evs) and incomplete(evs) == []


# --- F2 / B8 / B10: two real servers syncing over HTTP -------------------------------------------
def _free_port() -> int:
    with socket.socket() as sck:
        sck.bind(("127.0.0.1", 0))
        return sck.getsockname()[1]


@pytest.fixture
def two_devices(tmp_path):
    ports = [_free_port(), _free_port()]
    procs = []
    for i, port in enumerate(ports):
        env = {**os.environ, "DEVICE_ID": f"phone-{i + 1}", "DB_PATH": str(tmp_path / f"p{i}.db"),
               "PEERS": f"http://127.0.0.1:{ports[1 - i]}", "SYNC_KEY": "family-secret", "MODEL_MODE": "demo",
               "ALLOW_REMOTE_UI": "false", "WHISPER_PRELOAD": "false", "MIC_ENABLED": "false",
               "LEXICON_PATH": str(tmp_path / "lexicon.json")}
        (tmp_path / "lexicon.json").write_text(json.dumps(LEX), encoding="utf-8")
        procs.append(subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port)],
                                      cwd=Path(__file__).parent.parent, env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    urls = [f"http://127.0.0.1:{p}" for p in ports]
    deadline = time.time() + 60
    for u in urls:
        while True:
            try:
                httpx.get(u + "/health", timeout=1).raise_for_status()
                break
            except httpx.HTTPError:
                if time.time() > deadline:
                    raise
                time.sleep(0.3)
    yield urls
    for p in procs:
        p.terminate()
        p.wait(10)


def test_two_servers_sync_and_converge(two_devices):
    a, b = two_devices
    httpx.post(a + "/ingest/text", json={"text": "sharma ji ka 40 jama", "engine": "rules"}).raise_for_status()
    httpx.post(b + "/ingest/text", json={"text": "sharma ji ka 400 jama", "engine": "rules"}).raise_for_status()
    httpx.post(b + "/ingest/text", json={"text": "5 cup chai de", "engine": "rules"}).raise_for_status()
    r = httpx.post(a + "/sync/now", timeout=20).json()[b]
    assert (r["pulled"], r["pushed"], r["added"]) == (2, 1, 2)       # B10: both directions reported
    sa, sb = (httpx.get(u + "/ledger/summary").json() for u in (a, b))
    assert sa["balances_paise"] == sb["balances_paise"] and sa["balanced"]
    assert sa["conflicts"][0]["suspense_paise"] == 36000
    assert httpx.get(a + "/sync/frontier").status_code == 401        # B9: no key, no ledger
