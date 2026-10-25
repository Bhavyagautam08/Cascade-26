"""Probabilistic layer. Everything returns ranges, never a single blind number.

Evaluation chain: Raw Material Burn -> Inferred Wastage -> Reconciled Credit -> True Accrual Profit

- recipe_per_plate: how much of each ingredient one plate uses, learned from burn vs plates sold with
  non-negative least squares (no Bill of Materials needed). A non-negative constant term soaks up the
  steady loss per period; without it that loss would be smeared into "grams per plate" and the
  wastage signal would vanish. The burn plates can't explain is the wastage signal.
- wastage_from_ledger: the same, fed from the ledger itself (stock counts, purchases, sales).
- attribute_loss: splits unexplained stock loss into spoilage / theft / personal use. Starts from
  priors and shifts them with simple, explainable multipliers (heat, unattended hours, family).
  Uncertainty comes from a Dirichlet around the point estimate. These are assumptions, not learned:
  they are returned with every result (LOSS_MODEL).
- profit_range: Monte Carlo over every uncertain quantity (low-confidence amounts, stock not counted,
  customers who may never pay) -> p10 / p50 / p90 accrual profit. Assumptions in PROFIT_MODEL.
"""
from collections import defaultdict

import numpy as np
from scipy.optimize import nnls

from app.ledger.events import Event, Kind, Posting

RNG_SEED = 7  # reproducible demo numbers


# --- Raw Material Burn -> recipe -------------------------------------------------------------
def recipe_per_plate(burn: np.ndarray, plates: np.ndarray) -> dict:
    """burn: periods x ingredients consumed; plates: periods x dishes sold.

    Returns per-dish usage of each ingredient and the per-period burn the plates can't explain.
    """
    burn = np.asarray(burn, dtype=float)
    plates = np.asarray(plates, dtype=float)
    design = np.column_stack([plates, np.ones(len(plates))])     # last column: baseline loss per period
    coef = np.zeros((design.shape[1], burn.shape[1]))
    for j in range(burn.shape[1]):
        coef[:, j], _ = nnls(design, burn[:, j])
    usage, baseline = coef[:-1], coef[-1]
    unexplained = burn - plates @ usage
    # spread of residuals around the baseline = how sure we are about the recipe
    resid = unexplained - baseline
    resid_sd = resid.std(axis=0, ddof=1) if len(burn) > 1 else np.zeros(burn.shape[1])
    return {
        "usage_per_plate": usage.tolist(),             # dishes x ingredients
        "baseline_waste_per_day": baseline.tolist(),   # ingredients (per period)
        "unexplained_per_day": unexplained.tolist(),   # periods x ingredients (wastage signal)
        "residual_sd": resid_sd.tolist(),
    }


# --- Inferred Wastage -> loss attribution ----------------------------------------------------
# Not learned from data: there is no labelled loss data to learn from. These are explicit, editable
# assumptions, returned with every result so nobody mistakes them for measurements.
LOSS_MODEL = {
    "priors": {"spoilage": 0.5, "theft": 0.2, "personal": 0.3},
    "spoilage_per_degree_above_30c": 0.08,
    "spoilage_if_perishable": 1.5,
    "theft_per_unattended_hour": 0.15,
    "personal_per_family_member": 0.3,
    "dirichlet_concentration": 20.0,     # how strongly we trust the point estimate; sets interval width
}
PRIORS = LOSS_MODEL["priors"]


def attribute_loss(unexplained_kg: float, covariates: dict, concentration: float | None = None,
                   samples: int = 4000) -> dict:
    """covariates: temperature_c, unattended_hours, family_present, perishable (bool)."""
    m = LOSS_MODEL
    concentration = concentration or m["dirichlet_concentration"]
    w = dict(PRIORS)
    reasons = []
    t = covariates.get("temperature_c")
    if t is not None and t > 30:
        w["spoilage"] *= 1 + m["spoilage_per_degree_above_30c"] * (t - 30)
        reasons.append(f"hot day ({t}°C) raises spoilage")
    if covariates.get("perishable"):
        w["spoilage"] *= m["spoilage_if_perishable"]
        reasons.append("perishable item")
    h = covariates.get("unattended_hours", 0)
    if h:
        w["theft"] *= 1 + m["theft_per_unattended_hour"] * h
        reasons.append(f"stall unattended {h}h raises theft")
    f = covariates.get("family_present", 0)
    if f:
        w["personal"] *= 1 + m["personal_per_family_member"] * f
        reasons.append(f"{f} family members ate at the stall")

    total = sum(w.values())
    p = np.array([w[k] / total for k in PRIORS])
    rng = np.random.default_rng(RNG_SEED)
    draws = rng.dirichlet(p * concentration, size=samples)
    out = {}
    for i, k in enumerate(PRIORS):
        lo, hi = np.percentile(draws[:, i], [10, 90])
        out[k] = {"p": round(float(p[i]), 3), "p10": round(float(lo), 3), "p90": round(float(hi), 3),
                  "kg": round(float(p[i] * unexplained_kg), 3)}
    return {"split": out, "reasons": reasons, "assumptions": LOSS_MODEL}


# --- the chain from the ledger itself: stock counts -> burn -> recipe + wastage -> loss split ----
def _ordered(events: list[Event]) -> list[Event]:
    from app.ledger.store import causal_order
    return causal_order(events)


def wastage_from_ledger(events: list[Event], perishable: list[str] | None = None) -> dict:
    """Burn per ingredient between consecutive stock counts (previous count + bought - this count),
    regressed on plates sold in the same period. Needs at least (dishes + 1) count periods per
    ingredient; otherwise says so instead of guessing. Wall time is never used: periods are causal.
    """
    perishable_set = set(perishable or [])
    ev = [e for e in _ordered(events) if e.payload.get("item")]
    dishes = sorted({e.payload["item"] for e in ev if e.kind == Kind.sale and e.payload.get("qty")})
    counts_kinds = (Kind.stock_count, Kind.opening_stock)     # a morning inventory is a count too
    counted = sorted({e.payload["item"] for e in ev
                      if e.kind in counts_kinds and e.payload.get("qty") is not None})
    out: dict = {"dishes": dishes, "ingredients": {}}
    for ing in counted:
        counts = [i for i, e in enumerate(ev)
                  if e.kind in counts_kinds and e.payload["item"] == ing and e.payload.get("qty") is not None]
        burn, plates = [], []
        for a, b in zip(counts, counts[1:]):
            between = ev[a + 1:b + 1]
            bought = sum(e.payload.get("qty") or 0 for e in between
                         if e.kind == Kind.purchase and e.payload["item"] == ing)
            burn.append(ev[a].payload["qty"] + bought - ev[b].payload["qty"])
            plates.append([sum(e.payload.get("qty") or 0 for e in between
                               if e.kind == Kind.sale and e.payload["item"] == d) for d in dishes])
        res: dict = {"periods": len(burn), "burn": burn}
        if not dishes or len(burn) < len(dishes) + 1:
            res["status"] = f"need {len(dishes) + 1} stock-count periods, have {len(burn)}"
        else:
            fit = recipe_per_plate(np.array(burn)[:, None], np.array(plates))
            unexplained = max(0.0, float(np.sum(fit["unexplained_per_day"])))
            res.update(status="ok",
                       usage_per_dish={d: fit["usage_per_plate"][k][0] for k, d in enumerate(dishes)},
                       baseline_waste_per_period=fit["baseline_waste_per_day"][0], unexplained=unexplained,
                       loss=attribute_loss(unexplained, {"perishable": ing in perishable_set}))
        out["ingredients"][ing] = res
    return out


# --- Reconciled Credit + True Accrual Profit -------------------------------------------------
PROFIT_MODEL = {
    "collection_beta": [8.0, 2.0],               # every customer pays back ~80% on average (assumed)
    "unsold_fraction_if_uncounted": [0.0, 0.3],  # only for stock with no count after it was bought
    "amount_noise_sd": "0.5 x (1 - confidence)",
    "samples": 2000,
    "seed": RNG_SEED,
}


def _certain_postings(e: Event) -> list[Posting]:
    """Postings minus the receivable half of a disputed amount (see fusion.py conflicts).

    That half is parked against suspense, not revenue: it was never income, so it can't be owed
    for sure or become bad debt until a human settles the dispute.
    """
    disputed = e.payload.get("disputed_paise")
    if not disputed:
        return e.postings
    idx = next((i for i in reversed(range(len(e.postings)))
                if e.postings[i].account.startswith("receivable:") and abs(e.postings[i].amount) == disputed), None)
    return [p for i, p in enumerate(e.postings) if i != idx]


def profit_range(events: list[Event], collect_alpha: float = 8.0, collect_beta: float = 2.0,
                 unsold_fraction: tuple[float, float] = (0.0, 0.3), samples: int = 2000) -> dict:
    """Accrual profit (rupees) as a range, from the *effective* (fused) events.

    profit = revenue - cost of stock actually used - expenses - receivables unlikely to be paid

    Cost of stock used, per item: if the item was counted, purchases before its latest count minus the
    counted stock (valued at the average purchase price) - measured. Purchases after that count, and
    items never counted, fall back to the assumed unsold fraction. `cogs_method` says which applied.
    Money in suspense (unclassified) is not in profit until a human classifies it.
    """
    rng = np.random.default_rng(RNG_SEED)

    def noisy(amts: list[float], confs: list[float]) -> np.ndarray:
        """Each amount wobbles more the less sure we are about it."""
        if not amts:
            return np.zeros(samples)
        sd = np.array([0.5 * (1 - c) for c in confs])
        mult = np.clip(rng.normal(1.0, sd, size=(samples, len(amts))), 0, None)
        return (mult * np.array(amts, dtype=float)).sum(axis=1)

    ordered = _ordered(events)
    revenue: list[tuple[int, float]] = []
    expenses: list[tuple[int, float]] = []
    receivable: dict[str, int] = defaultdict(int)
    buys: dict[str, list[tuple[int, int, float, float | None]]] = defaultdict(list)  # item -> (pos, paise, conf, qty)
    last_count: dict[str, tuple[int, float, float]] = {}                               # item -> (pos, qty, conf)
    for pos, e in enumerate(ordered):
        if e.kind == Kind.stock_count and e.payload.get("item") and e.payload.get("qty") is not None:
            last_count[e.payload["item"]] = (pos, float(e.payload["qty"]), e.confidence)
        for p in _certain_postings(e):
            if p.account == "revenue:sales":
                revenue.append((-p.amount, e.confidence))
            elif p.account.startswith("inventory:") and e.kind in (Kind.purchase, Kind.opening_stock):
                # opening stock is stock available to be used today, like a purchase (but not today's cash)
                buys[p.account.split(":", 1)[1]].append((pos, p.amount, e.confidence, e.payload.get("qty")))
            elif p.account.startswith("expense:"):
                expenses.append((p.amount, e.confidence))
            elif p.account.startswith("receivable:"):
                receivable[p.account] += p.amount

    rev = noisy([a for a, _ in revenue], [c for _, c in revenue])
    exp = noisy([a for a, _ in expenses], [c for _, c in expenses])
    cogs = np.zeros(samples)
    method: dict[str, str] = {}
    for item, rows in buys.items():
        qty_known = [(paise, q) for _, paise, _, q in rows if q]
        count = last_count.get(item)
        if count and qty_known:
            unit_cost = sum(p for p, _ in qty_known) / sum(q for _, q in qty_known)
            before = [r for r in rows if r[0] < count[0]]
            after = [r for r in rows if r[0] > count[0]]
            counted_value = count[1] * unit_cost * np.clip(rng.normal(1.0, 0.5 * (1 - count[2]), samples), 0, None)
            used = noisy([r[1] for r in before], [r[2] for r in before]) - counted_value
            cogs += np.clip(used, 0, None)
            cogs += noisy([r[1] for r in after], [r[2] for r in after]) * (1 - rng.uniform(*unsold_fraction, samples))
            method[item] = "stock_count"
        else:
            cogs += noisy([r[1] for r in rows], [r[2] for r in rows]) * (1 - rng.uniform(*unsold_fraction, samples))
            method[item] = "assumed_unsold_fraction" if not count else "assumed (purchases have no quantity)"
    outstanding = float(sum(v for v in receivable.values() if v > 0))
    collect_p = rng.beta(collect_alpha, collect_beta, size=samples)
    bad_debt = outstanding * (1 - collect_p)

    profit = (rev - cogs - exp - bad_debt) / 100.0
    p10, p50, p90 = np.percentile(profit, [10, 50, 90])
    med = lambda x: round(float(np.median(x)) / 100.0, 2)  # noqa: E731
    return {
        "p10": round(float(p10), 2), "p50": round(float(p50), 2), "p90": round(float(p90), 2),
        "components": {"revenue": med(rev), "cogs": med(cogs), "expenses": med(exp),
                       "expected_bad_debt": med(bad_debt)},
        "receivables": {k.split(":", 1)[1]: v / 100.0 for k, v in receivable.items() if v},
        "cogs_method": method,
        "assumptions": PROFIT_MODEL,
    }
