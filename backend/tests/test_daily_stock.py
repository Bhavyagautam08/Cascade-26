"""A1 + A2 maths: what was used per trading day (morning count -> evening count), what changed overnight,
and the day's profit from those counts. Every figure must come from counts, purchases and sales in the
ledger - never from a stand-in."""
import pytest

from app.ledger import days, inference
from app.ledger.doubleentry import postings_for
from app.ledger.events import CandidateEvent, Kind, Source
from app.ledger.fusion import fuse
from app.ledger.store import EventStore


def _put(s: EventStore, kind: Kind, item=None, qty=None, unit=None, amount=None, **extra):
    c = CandidateEvent(kind=kind, source=Source.manual, confidence=1.0, item=item, qty=qty, unit=unit,
                       amount_rupees=amount)
    payload = {**c.model_dump(exclude={"kind", "source", "raw", "confidence"}), **extra}
    return s.append_local(kind, Source.manual, postings_for(c), payload=payload)


def _morning(s, item, qty, unit="kg", cost=None):
    return _put(s, Kind.opening_stock, item, qty, unit, cost, inventory="opening")


def _evening(s, item, qty, unit="kg"):
    return _put(s, Kind.stock_count, item, qty, unit, None, inventory="closing", closing=True)


def _sell(s, dish, plates, price=20):
    return _put(s, Kind.sale, dish, plates, "plate", plates * price)


def _buy(s, item, qty, amount, unit="kg"):
    return _put(s, Kind.purchase, item, qty, unit, amount)


def test_trading_day_burn_and_overnight_change_are_separate(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-1")
    _morning(s, "poha", 10, cost=400); _sell(s, "poha", 50); _evening(s, "poha", 5.8)
    days.start_day(s)
    _morning(s, "poha", 5.5); _buy(s, "poha", 2, 80); _sell(s, "poha", 80); _evening(s, "poha", 0.9)
    poha = inference.wastage_from_ledger(s.all())["ingredients"]["poha"]
    trading = [r for r in poha["rows"] if r["kind"] == "trading"]
    assert [round(r["burn"], 3) for r in trading] == [4.2, 6.6]               # 10-5.8 ; 5.5+2-0.9
    assert [r["plates"]["poha"] for r in trading] == [50, 80]
    assert [round(o["change"], 3) for o in poha["overnight"]] == [0.3]        # 5.8 at night -> 5.5 next morning
    assert poha["periods"] == 2 and poha["burn"] == [pytest.approx(4.2), pytest.approx(6.6)]


def test_day_without_a_morning_count_starts_from_last_nights_count(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-1")
    _morning(s, "poha", 10); _sell(s, "poha", 50); _evening(s, "poha", 5.8)
    days.start_day(s)
    _sell(s, "poha", 40); _evening(s, "poha", 2.4)                            # no morning entry today
    rows = inference.wastage_from_ledger(s.all())["ingredients"]["poha"]["rows"]
    assert rows[1]["kind"] == "trading" and rows[1]["start_kind"] == "stock_count"
    assert round(rows[1]["burn"], 3) == 3.4 and rows[1]["plates"]["poha"] == 40


def test_purchase_in_another_unit_is_not_mixed_in(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-1")
    _morning(s, "poha", 10); _buy(s, "poha", 3, 150, unit="packet"); _sell(s, "poha", 50); _evening(s, "poha", 5.8)
    row = inference.wastage_from_ledger(s.all())["ingredients"]["poha"]["rows"][0]
    assert row["kind"] == "excluded" and "packet" in row["note"] and row["burn"] is None


def test_recipe_is_recovered_from_trading_days_only(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-1")
    left = 12.0
    for plates, overnight in ((50, 0.3), (80, 0.2), (65, 0.4), (40, 0.1)):
        _morning(s, "poha", round(left, 3))
        _sell(s, "poha", plates)
        left = left - plates * 0.08 - 0.2                                     # 80 g/plate + 0.2 kg waste a day
        _evening(s, "poha", round(left, 3))
        days.start_day(s)
        left = left - overnight + 6.0                                         # overnight loss, then restocked
        _buy(s, "poha", 6.0, 240)
    poha = inference.wastage_from_ledger(s.all())["ingredients"]["poha"]
    assert poha["status"] == "ok"
    assert abs(poha["usage_per_dish"]["poha"] - 0.08) < 0.005
    assert abs(poha["baseline_waste_per_period"] - 0.2) < 0.05


def test_days_profit_uses_its_morning_and_evening_counts(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-1")
    _morning(s, "tomato", 5, cost=200)                                        # Rs40/kg
    _buy(s, "tomato", 5, 200)
    _evening(s, "tomato", 3)                                                  # used 7 kg = Rs280
    p = inference.day_profit(fuse(s.all()).effective, days.current_day(s.all()))
    assert p["cogs_method"] == {"tomato": "stock_count"}
    assert 250 < p["components"]["cogs"] < 310


def test_next_days_profit_starts_from_last_nights_count(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-1")
    _morning(s, "tomato", 5, cost=200); _evening(s, "tomato", 4)              # 4 kg left, worth Rs160
    days.start_day(s)
    _buy(s, "tomato", 2, 80); _evening(s, "tomato", 1)                        # no morning entry: 4 + 2 - 1 = 5 kg
    p = inference.day_profit(fuse(s.all()).effective, 1)
    assert p["cogs_method"] == {"tomato": "stock_count (opening = last count of an earlier day)"}
    assert 170 < p["components"]["cogs"] < 230                                # 5 kg at Rs40


def test_an_unvalued_carried_count_is_said_not_guessed(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-1")
    _morning(s, "dhaniya", 1); _evening(s, "dhaniya", 0.5)                    # never had a price, on any day
    days.start_day(s)
    _evening(s, "dhaniya", 0.2)
    p = inference.day_profit(fuse(s.all()).effective, 1)
    assert "no price known" in p["cogs_method"]["dhaniya"]
    assert p["components"]["cogs"] == 0                                       # not valued, and says so


def test_a_later_price_values_stock_left_from_an_earlier_day(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-1")
    _morning(s, "dhaniya", 1); _evening(s, "dhaniya", 0.5)
    days.start_day(s)
    _buy(s, "dhaniya", 1, 30); _evening(s, "dhaniya", 0.2)                    # Rs30/kg is the known price
    p = inference.day_profit(fuse(s.all()).effective, 1)
    assert p["cogs_method"]["dhaniya"] == inference.CARRIED
    assert 30 < p["components"]["cogs"] < 50                                   # 0.5 + 1 - 0.2 = 1.3 kg at Rs30


def test_a_morning_count_said_without_a_price_is_valued_at_the_known_price(tmp_path):
    s = EventStore(tmp_path / "a.db", "phone-1")
    _morning(s, "poha", 10, cost=400); _evening(s, "poha", 6)                # Rs40/kg known from day 1
    days.start_day(s)
    _morning(s, "poha", 6)                                                    # "mere paas 6 kilo poha hai"
    _buy(s, "poha", 4, 160); _evening(s, "poha", 3)                           # used 6 + 4 - 3 = 7 kg = Rs280
    p = inference.day_profit(fuse(s.all()).effective, 1)
    assert p["cogs_method"]["poha"] == "stock_count"
    assert 250 < p["components"]["cogs"] < 310
