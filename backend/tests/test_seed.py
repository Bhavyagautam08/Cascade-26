"""B2: a simulated multi-day history, generated from a declared scenario through the app's own ledger
code. The scenario plants a recipe and waste; the app must recover them from the ledger alone."""
import copy
import json
from pathlib import Path

import pytest

from app import seed
from app.ledger import days, inference
from app.ledger.doubleentry import trial_balance_ok
from app.ledger.fusion import fuse
from app.ledger.store import EventStore

SCENARIO = json.loads((Path(__file__).parent.parent.parent / "scripts" / "demo_scenario.json").read_text(encoding="utf-8"))


def test_seed_writes_the_declared_days_and_balanced_books(tmp_path):
    s = EventStore(tmp_path / "demo.db", SCENARIO["device_id"])
    report = seed.run(s, SCENARIO)
    evs = s.all()
    assert days.current_day(evs) == SCENARIO["days"]
    assert trial_balance_ok(fuse(evs).effective)
    assert all("demo_seed" in (e.payload.get("flags") or []) for e in evs if e.kind.value != "day_start")
    assert report["days"] == SCENARIO["days"] and report["events"] == len(evs)


def test_the_app_recovers_the_planted_recipe_from_the_ledger(tmp_path):
    s = EventStore(tmp_path / "demo.db", SCENARIO["device_id"])
    report = seed.run(s, SCENARIO)
    w = inference.wastage_from_ledger(fuse(s.all()).effective)
    for dish, uses in SCENARIO["recipe_per_plate"].items():
        for ingredient, planted in uses.items():
            got = w["ingredients"][ingredient]["usage_per_dish"][dish]
            assert abs(got - planted) <= 0.25 * planted + 0.005, (dish, ingredient, got, planted)
    assert report["recovered"]                                            # the script prints the same check


def test_each_day_has_a_morning_and_an_evening_count_and_a_profit(tmp_path):
    s = EventStore(tmp_path / "demo.db", SCENARIO["device_id"])
    seed.run(s, SCENARIO)
    evs = s.all()
    eff = fuse(evs).effective
    for d in range(1, SCENARIO["days"] + 1):
        assert {e.payload["inventory"] for e in days.in_day(evs, d) if e.payload.get("inventory")} == {"opening", "closing"}
        p = inference.day_profit(eff, d)
        assert p["p10"] <= p["p50"] <= p["p90"] and p["components"]["revenue"] > 0
        assert set(p["cogs_method"].values()) <= {"stock_count", inference.CARRIED}   # measured, never assumed


def test_seed_refuses_a_ledger_that_already_has_entries(tmp_path):
    s = EventStore(tmp_path / "demo.db", SCENARIO["device_id"])
    seed.run(s, SCENARIO)
    with pytest.raises(seed.NotEmpty):
        seed.run(s, SCENARIO)


def test_an_impossible_scenario_is_an_error_not_a_clamp(tmp_path):
    bad = copy.deepcopy(SCENARIO)
    first = next(iter(bad["opening"]))
    bad["opening"][first] = 0.0                                           # can't cook from nothing
    for ing in bad["ingredients"].values():
        ing["restock_below"] = -1                                         # and never restock
    with pytest.raises(seed.ScenarioError):
        seed.run(EventStore(tmp_path / "demo.db", bad["device_id"]), bad)
