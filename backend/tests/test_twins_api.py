"""The person's side of twins over HTTP: list possible duplicates, say "same" / "separate", settle a
dispute about a sale. Uses the app's own ledger (pipeline.store) and a second, in-test phone."""
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app import pipeline
from app.ledger.doubleentry import postings_for
from app.ledger.store import EventStore
from app.main import app
from app.perception import rules

LEX = json.loads((Path(__file__).parent.parent / "data" / "lexicon.json").read_text(encoding="utf-8"))
client = TestClient(app)


def _other_phone(tmp_path, name="phone-9"):
    t = [1000.0]
    s = EventStore.open(tmp_path / f"{name}.db", name, mono=lambda: t[0])
    return s, t


def _say(store, text):
    (c,) = rules.parse(text, LEX)
    return store.append_local(c.kind, c.source, postings_for(c),
                              payload=c.model_dump(exclude={"kind", "source", "raw", "confidence"}),
                              confidence=c.confidence, raw=c.raw)


def _here(text):
    return client.post("/ingest/text", json={"text": text, "engine": "rules"}).json()["events"][0]


def _cash():
    return client.get("/ledger/balances").json()["balances_paise"].get("cash", 0)


def test_possible_duplicates_are_listed_and_a_person_can_merge_them(tmp_path):
    other, _ = _other_phone(tmp_path)
    other.ingest(pipeline.store.all())                      # synced earlier today (same business day)...
    before = _cash()                                        # ...then out of touch: no shared moments
    mine = _here("9 plate poha de 180")
    theirs = _say(other, "9 plate poha de 180")
    pipeline.store.ingest([theirs])
    s = client.get("/ledger/summary").json()
    assert {"ids": [mine["id"], theirs.id]}.items() <= next(
        p for p in s["possible_duplicates"] if theirs.id in p["ids"]).items()
    assert _cash() - before == 36000
    r = client.post("/ledger/same", json={"ids": [mine["id"], theirs.id]})
    assert r.status_code == 200, r.text
    assert _cash() - before == 18000
    assert not any(theirs.id in p["ids"] for p in client.get("/ledger/summary").json()["possible_duplicates"])


def test_same_is_refused_for_different_amounts_or_unknown_ids():
    a = _here("3 plate poha de 60")
    b = _here("3 plate poha de 70")
    r = client.post("/ledger/same", json={"ids": [a["id"], b["id"]]})
    assert r.status_code == 422 and "60" in r.json()["detail"] and "70" in r.json()["detail"]
    assert client.post("/ledger/same", json={"ids": [a["id"], "nope:1"]}).status_code == 404
    assert client.post("/ledger/same", json={"ids": [a["id"]]}).status_code == 422


def test_a_sale_heard_with_two_amounts_is_settled_by_the_vendor(tmp_path):
    other, t = _other_phone(tmp_path, "phone-8")
    pipeline.store.record_contact(other.device_id, "sync-api-1")
    other.record_contact(pipeline.store.device_id, "sync-api-1")
    before = _cash()
    mine = _here("4 plate poha de 80")
    t[0] += 2.0
    theirs = _say(other, "4 plate poha de 90")
    pipeline.store.ingest([theirs])
    c = next(c for c in client.get("/ledger/summary").json()["conflicts"] if theirs.id in c["ids"])
    assert c["claims_paise"] == [8000, 9000] and c["kind"] == "sale" and c["item"] == "poha"
    assert _cash() - before == 8000                          # the lower claim, once
    r = client.post("/ledger/resolve", json={"ids": c["ids"], "amount_rupees": 90})
    assert r.status_code == 200, r.text
    settled = r.json()["events"][0]
    assert settled["payload"]["item"] == "poha" and settled["payload"]["qty"] == 4
    assert _cash() - before == 9000
    assert not any(theirs.id in c["ids"] for c in client.get("/ledger/summary").json()["conflicts"])
