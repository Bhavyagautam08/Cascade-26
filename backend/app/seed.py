"""Simulated multi-day history for demos (B2), written through the app's own ledger code.

Nothing here is used by the app at runtime. A declared scenario (scripts/demo_scenario.json) plants a
recipe, waste, prices and a few udhaar/expense entries; this module simulates the days and records them
exactly as a vendor would: day start -> morning inventory -> restock purchases -> sales -> evening count.
Every entry carries the flag "demo_seed" and its text starts with "[demo]", so it can never pass for
real trading. The report compares what was planted with what the app recovers from the ledger.

Refuses a ledger that already has entries, and raises on an impossible scenario (stock running out)
instead of clamping numbers to make it work.
"""
import datetime as dt

import numpy as np

from app import inventory as inv
from app.ledger import days, inference
from app.ledger.doubleentry import postings_for
from app.ledger.events import CandidateEvent, Kind, Source
from app.ledger.fusion import fuse

FLAG = "demo_seed"


class NotEmpty(RuntimeError):
    pass


class ScenarioError(ValueError):
    pass


def _book(store, kind: Kind, text: str, **fields) -> None:
    from app.pipeline import as_recorded
    c = as_recorded(CandidateEvent(kind=kind, source=Source.manual, confidence=1.0, flags=[FLAG], raw=text, **fields))
    store.append_local(c.kind, Source.manual, postings_for(c),
                       payload=c.model_dump(exclude={"kind", "source", "raw", "confidence"}), confidence=1.0, raw=text)


def _items(stock: dict, sc: dict, priced: bool) -> list[inv.InventoryItem]:
    out = []
    for ing, qty in stock.items():
        spec = sc["ingredients"][ing]
        cost = round(qty * spec["price_per_unit"], 2) if priced else None
        out.append(inv.InventoryItem(item=ing, qty=round(qty, 2), unit=spec["unit"], total_cost=cost,
                                     status="opening", confidence=1.0, flags=[FLAG],
                                     said=f"{round(qty, 2):g} {spec['unit']} {ing}"))
    return out


def run(store, sc: dict) -> dict:
    if store.all():
        raise NotEmpty("this ledger already has entries; seed an empty one (e.g. DB_PATH=data/ledger-demo.db)")
    rng = np.random.default_rng(sc["seed"])
    n = sc["days"]
    clock = {"t": 0.0}
    real_clock, store.wall_clock = store.wall_clock, lambda: clock["t"]   # simulated times, display only
    try:
        stock = {k: float(v) for k, v in sc["opening"].items()}
        for k in range(n):
            date = dt.date.today() - dt.timedelta(days=n - 1 - k)
            clock["t"] = dt.datetime.combine(date, dt.time(6, 30)).timestamp()

            def later(minutes: float) -> None:
                clock["t"] += minutes * 60

            days.start_day(store)
            later(10)
            morning = _items(stock, sc, priced=(k == 0))           # the first morning says what it cost
            inv.confirm(store, f"seed:{date}:opening", "[demo] " + ", ".join(i.said for i in morning),
                        morning, Source.manual, mode="opening")
            for ing, spec in sc["ingredients"].items():
                if stock[ing] < spec["restock_below"]:
                    qty = round(spec["restock_to"] - stock[ing], 2)
                    amount = round(qty * spec["price_per_unit"], 2)
                    later(15)
                    _book(store, Kind.purchase, f"[demo] {qty:g} {spec['unit']} {ing} liya {amount:g} mein",
                          item=ing, qty=qty, unit=spec["unit"], amount_rupees=amount)
                    stock[ing] += qty
            for e in sc.get("expenses", []):
                if e["day"] == k + 1:
                    _book(store, Kind.expense, f"[demo] {e['item']} ka {e['amount']} kharcha",
                          item=e["item"], amount_rupees=e["amount"])
            plates = {d: int(rng.integers(spec["plates_per_day"][0], spec["plates_per_day"][1] + 1))
                      for d, spec in sc["dishes"].items()}
            for d, total in plates.items():                        # sold in a few batches through the day
                cuts = sorted(rng.choice(np.arange(1, total), size=2, replace=False))
                for part in np.diff([0, *cuts, total]):
                    later(60)
                    amount = int(part) * sc["dishes"][d]["price"]
                    _book(store, Kind.sale, f"[demo] {int(part)} plate {d} becha {amount}",
                          item=d, qty=int(part), unit="plate", amount_rupees=amount)
            for u in sc.get("udhaar", []):
                if u["day"] == k + 1:
                    later(20)
                    if "given" in u:
                        _book(store, Kind.credit_given, f"[demo] {u['party']} ji ka {u['given']} udhaar likh",
                              party=u["party"], amount_rupees=u["given"])
                    if "paid" in u:
                        _book(store, Kind.credit_paid, f"[demo] {u['party']} ji ka {u['paid']} jama",
                              party=u["party"], amount_rupees=u["paid"])
            for ing, spec in sc["ingredients"].items():            # what the day really used (planted)
                used = sum(plates[d] * sc["recipe_per_plate"][d].get(ing, 0) for d in plates)
                used += spec["waste_per_day"] * rng.uniform(0.8, 1.2)
                stock[ing] = round(stock[ing] - used, 2)            # the evening count is to 10 g / 10 ml
                if stock[ing] < 0:
                    raise ScenarioError(f"day {k + 1}: {ing} ran out ({stock[ing]:g} {spec['unit']}); "
                                        "raise the opening stock or the restock levels")
            later(120)
            evening = [i.model_copy(update={"status": "closing", "total_cost": None}) for i in _items(stock, sc, False)]
            inv.confirm(store, f"seed:{date}:closing", "[demo] bacha: " + ", ".join(i.said for i in evening),
                        evening, Source.manual, mode="closing")
            for ing, spec in sc["ingredients"].items():            # overnight spoilage before the next morning
                stock[ing] = round(stock[ing] - spec["overnight_loss"], 2)
                if stock[ing] < 0:
                    raise ScenarioError(f"night after day {k + 1}: {ing} below zero")
    finally:
        store.wall_clock = real_clock

    events = store.all()
    w = inference.wastage_from_ledger(fuse(events).effective)
    recovered, rows = True, []
    for dish, uses in sc["recipe_per_plate"].items():
        for ing, planted in uses.items():
            got = w["ingredients"].get(ing, {}).get("usage_per_dish", {}).get(dish)
            ok = got is not None and abs(got - planted) <= 0.25 * planted + 0.005
            recovered &= ok
            rows.append({"dish": dish, "ingredient": ing, "planted": planted, "recovered": got, "ok": ok})
    return {"days": n, "events": len(events), "recipe": rows, "recovered": recovered}
