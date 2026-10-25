"""Morning inventory: the checks that must hold whatever the language model returns.

The model's output is replayed as data (_LLMItem); the real model is exercised by eval/run_eval.py.
"""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import inventory as inv
from app.inventory import InventoryItem, _LLMItem, check
from app.ledger.doubleentry import balances, trial_balance_ok
from app.ledger.events import Kind, Source
from app.ledger.store import EventStore
from app.perception.rules import spoken_numbers

LEX = json.loads((Path(__file__).parent.parent / "data" / "lexicon.json").read_text(encoding="utf-8"))
SPEC = ("Aaj subah mere paas 5 kilo tamatar hain, jo 200 rupaye ke khareede the. Do kilo aloo hain 80 rupaye "
        "ke, aur 100 puriyan hain jo 100 rupaye ki hain.")


def said(text):
    return spoken_numbers(text, LEX)


def test_spec_example_quantities_costs_and_unit_costs():
    t = said(SPEC)
    items = [check(_LLMItem(said="5 kilo tamatar hain, jo 200 rupaye ke khareede the", item="tomato", qty=5, unit="kilo",
                            total_cost=200, status="opening"), t, LEX),
             check(_LLMItem(said="Do kilo aloo hain 80 rupaye ke", item="potato", qty=2, unit="kilo", total_cost=80,
                            status="opening"), t, LEX),
             check(_LLMItem(said="100 puriyan hain jo 100 rupaye ki hain", item="puri", qty=100, unit="piece",
                            total_cost=100, status="opening"), t, LEX)]
    assert [(i.item, i.qty, i.unit, i.total_cost, i.unit_cost, i.question) for i in items] == [
        ("tomato", 5, "kg", 200, 40, None), ("potato", 2, "kg", 80, 40, None), ("puri", 100, "piece", 100, 1, None)]


def test_grams_convert_and_unit_cost_is_per_kg():
    i = check(_LLMItem(said="500 gram paneer 160 ka", item="paneer", qty=500, unit="gram", total_cost=160,
                       status="opening"), said("500 gram paneer 160 ka"), LEX)
    assert (i.qty, i.unit, i.unit_cost) == (0.5, "kg", 320)


def test_numbers_not_said_are_removed_not_kept():
    t = said("mere paas tamatar hain")
    i = check(_LLMItem(said="tamatar hain", item="tomato", qty=5, unit="kilo", total_cost=200, status="opening"), t, LEX)
    assert i.qty is None and i.total_cost is None and i.unit_cost is None
    assert "quantity_not_heard:5" in i.flags and "cost_not_heard:200" in i.flags
    assert i.question and "How much tomato" in i.question                        # asks, never assumes


def test_missing_unit_and_unclear_status_become_questions():
    t = said("7 dhaniya, aur aloo 2 kilo")
    no_unit = check(_LLMItem(said="7 dhaniya", item="coriander", qty=7, unit=None, status="opening"), t, LEX)
    unclear = check(_LLMItem(said="aloo 2 kilo", item="potato", qty=2, unit="kilo", status="unclear"), t, LEX)
    assert "kilo, litre, or pieces" in no_unit.question
    assert "this morning, or was it already with you" in unclear.question
    assert "cost_missing" in no_unit.flags and no_unit.unit_cost is None


@pytest.mark.parametrize("words, status", [
    ("mere paas 5 kilo tamatar hain, jo 200 rupaye ke khareede the", "opening"),   # have; bought earlier
    ("subah mandi se 3 kilo pyaaz laya 90 rupaye mein", "purchased"),
    ("aaj 2 litre doodh liya hai", "purchased"),                                   # bought today, now held
    ("2 kilo aloo kal ka pada hai", "opening"),
    ("tamatar 4 kilo, 160 rupaye", "unclear"),                                     # no verb: ask
])
def test_held_or_bought_comes_from_the_words(words, status):
    assert inv.status_from_words(words) == status


def test_price_the_model_dropped_is_taken_from_the_items_own_words():
    t = said(SPEC)
    i = check(_LLMItem(said="mere paas 5 kilo tamatar hain, jo 200 rupaye ke khareede the", item="tomato", qty=5,
                       unit="kilo", total_cost=None, status="opening"), t, LEX)
    assert (i.total_cost, i.unit_cost) == (200, 40) and "cost_from_words" in i.flags
    two = check(_LLMItem(said="tamatar 5 kilo 200 rupaye, aloo 80 rupaye", item="tomato", qty=5, unit="kilo",
                         total_cost=None, status="opening"), "tamatar 5 kilo 200 rupaye, aloo 80 rupaye", LEX)
    assert two.total_cost is None                                            # two amounts: don't pick one


def test_model_status_is_overruled_by_the_words():
    i = check(_LLMItem(said="tamatar 4 kilo, 160 rupaye", item="tomato", qty=4, unit="kilo", total_cost=160,
                       status="opening"), "tamatar 4 kilo, 160 rupaye", LEX)
    assert i.status == "unclear" and "already with you" in i.question


def _item(name, status="opening", qty=1.0, unit="kg", cost=50.0):
    return InventoryItem(item=name, qty=qty, unit=unit, total_cost=cost, status=status, confidence=1.0)


def test_confirm_books_opening_stock_and_todays_purchases(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-1")
    r = inv.confirm(s, "rec-1", SPEC, [_item("tomato", cost=200, qty=5), _item("milk", "purchased", 2, "l", 120),
                                       _item("bread", "purchased", 1, "packet", None)], Source.voice)
    kinds = [e["kind"] for e in r["events"]]
    assert kinds == ["opening_stock", "purchase", "order"]                   # no price -> order, never a guess
    bal = balances(s.all())
    assert bal["inventory:tomato"] == 20000 and bal["equity:opening_stock"] == -20000    # not today's cash
    assert bal["cash"] == -12000 and trial_balance_ok(s.all())
    assert r["events"][0]["payload"]["unit_cost"] == 40                     # 200 / 5 kg, computed on save
    assert r["events"][2]["payload"]["unit_cost"] is None                   # no cost said -> no unit cost


def test_same_recording_twice_is_saved_once(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-1")
    first = inv.confirm(s, "rec-1", SPEC, [_item("tomato")], Source.voice)
    again = inv.confirm(s, "rec-1", SPEC, [_item("tomato")], Source.voice)
    assert again["duplicate"] and [e["id"] for e in again["events"]] == [e["id"] for e in first["events"]]
    assert len(s.all()) == 1


def test_same_recording_after_sync_from_another_phone_is_not_saved_again(tmp_path):
    a, b = EventStore(tmp_path / "a.db", "phone-1"), EventStore(tmp_path / "b.db", "phone-2")
    inv.confirm(a, "rec-1", SPEC, [_item("tomato")], Source.voice)           # saved offline on phone-1
    b.ingest(a.all())                                                         # phones meet later
    assert inv.confirm(b, "rec-1", SPEC, [_item("tomato")], Source.voice)["duplicate"]


def test_confirmed_stock_is_never_overwritten_without_consent(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-1")
    inv.confirm(s, "rec-1", SPEC, [_item("tomato", qty=5)], Source.voice)
    with pytest.raises(inv.WouldOverwrite):
        inv.confirm(s, "rec-2", "6 kilo tamatar", [_item("tomato", qty=6)], Source.voice)
    r = inv.confirm(s, "rec-2", "6 kilo tamatar", [_item("tomato", qty=6)], Source.voice, replace=True)
    today = inv.todays_inventory(s.all())
    assert len(today) == 1 and today[0].payload["qty"] == 6 and r["replaced"]
    assert len(s.all()) == 2                                                  # the old entry is kept in the log


def test_open_questions_block_saving(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-1")
    with pytest.raises(inv.NeedsAnswers):
        inv.confirm(s, "rec-1", "", [_item("tomato", status="unclear")], Source.voice)
    with pytest.raises(inv.NeedsAnswers):
        inv.confirm(s, "rec-1", "", [_item("tomato", qty=None)], Source.voice)
    assert s.all() == []


def test_opening_stock_counts_as_stock_for_wastage(tmp_path):
    from app.ledger.inference import wastage_from_ledger
    s = EventStore(tmp_path / "a.db", "phone-1")
    inv.confirm(s, "rec-1", "", [_item("tomato", qty=5, cost=200)], Source.voice)
    s.append_local(Kind.stock_count, Source.voice, [], payload={"item": "tomato", "qty": 2.0, "unit": "kg"})
    assert wastage_from_ledger(s.all())["ingredients"]["tomato"]["burn"] == [3.0]   # 5 in the morning, 2 left


# --- through the API (demo mode: no language model) ---------------------------------------------------
def test_api_confirm_duplicate_and_overwrite():
    from app.main import app
    c = TestClient(app)
    body = {"recording_id": "api-rec-1", "transcript": SPEC,
            "items": [{"item": "api-tomato", "qty": 5, "unit": "kg", "total_cost": 200, "status": "opening"}]}
    first = c.post("/inventory/confirm", json=body).json()
    assert not first["duplicate"] and first["events"][0]["kind"] == "opening_stock"
    assert c.post("/inventory/confirm", json=body).json()["duplicate"]
    clash = c.post("/inventory/confirm", json={**body, "recording_id": "api-rec-2"})
    assert clash.status_code == 409 and clash.json()["detail"]["existing"][0]["item"] == "api-tomato"
    unclear = c.post("/inventory/confirm", json={**body, "recording_id": "api-rec-3",
                                                 "items": [{**body["items"][0], "item": "x", "status": "unclear"}]})
    assert unclear.status_code == 422 and unclear.json()["detail"]["items"][0]["question"]
    assert any(e["payload"]["item"] == "api-tomato" for e in c.get("/inventory/today").json()["events"])


def test_api_empty_recording_and_no_model_are_clear_errors():
    from app.main import app
    c = TestClient(app)
    empty = c.post("/inventory/voice", files={"file": ("x.webm", b"", "audio/webm")})
    assert empty.status_code == 422 and "empty" in empty.json()["detail"]
    typed = c.post("/inventory/text", json={"text": SPEC})                  # demo mode has no language model
    assert typed.status_code == 503 and "type the items" in typed.json()["detail"]
