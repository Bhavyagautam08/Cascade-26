"""Probabilistic layer. Everything returns ranges, never a single blind number.

Evaluation chain: Raw Material Burn -> Inferred Wastage -> Reconciled Credit -> True Accrual Profit

- recipe_per_plate: how much of each ingredient one plate uses, learned from daily burn vs plates
  sold with non-negative least squares (no Bill of Materials needed). The leftover burn that plates
  can't explain is the wastage signal.
- attribute_loss: splits unexplained stock loss into spoilage / theft / personal use. Starts from
  priors and shifts them with simple, explainable multipliers (heat, unattended hours, family).
  Uncertainty comes from a Dirichlet around the point estimate.
- profit_range: Monte Carlo over every uncertain quantity (low-confidence amounts, unsold stock,
  customers who may never pay) -> p10 / p50 / p90 accrual profit.
"""
from collections import defaultdict

import numpy as np
from scipy.optimize import nnls

from app.ledger.events import Event, Kind

RNG_SEED = 7  # reproducible demo numbers


# --- Raw Material Burn -> recipe -------------------------------------------------------------
def recipe_per_plate(burn: np.ndarray, plates: np.ndarray) -> dict:
    """burn: days x ingredients consumed; plates: days x dishes sold.

    Returns per-dish usage of each ingredient and the per-day burn the plates can't explain.
    """
    burn = np.asarray(burn, dtype=float)
    plates = np.asarray(plates, dtype=float)
    usage = np.zeros((plates.shape[1], burn.shape[1]))
    for j in range(burn.shape[1]):
        usage[:, j], _ = nnls(plates, burn[:, j])
    unexplained = burn - plates @ usage
    # spread of residuals = how sure we are about the recipe
    resid_sd = unexplained.std(axis=0, ddof=1) if len(burn) > 1 else np.zeros(burn.shape[1])
    return {
        "usage_per_plate": usage.tolist(),             # dishes x ingredients
        "unexplained_per_day": unexplained.tolist(),   # days x ingredients (wastage signal)
        "residual_sd": resid_sd.tolist(),
    }


# --- Inferred Wastage -> loss attribution ----------------------------------------------------
PRIORS = {"spoilage": 0.5, "theft": 0.2, "personal": 0.3}


def attribute_loss(unexplained_kg: float, covariates: dict, concentration: float = 20.0,
                   samples: int = 4000) -> dict:
    """covariates: temperature_c, unattended_hours, family_present, perishable (bool)."""
    w = dict(PRIORS)
    reasons = []
    t = covariates.get("temperature_c")
    if t is not None and t > 30:
        w["spoilage"] *= 1 + 0.08 * (t - 30)
        reasons.append(f"hot day ({t}°C) raises spoilage")
    if covariates.get("perishable"):
        w["spoilage"] *= 1.5
        reasons.append("perishable item")
    h = covariates.get("unattended_hours", 0)
    if h:
        w["theft"] *= 1 + 0.15 * h
        reasons.append(f"stall unattended {h}h raises theft")
    f = covariates.get("family_present", 0)
    if f:
        w["personal"] *= 1 + 0.3 * f
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
    return {"split": out, "reasons": reasons}


# --- Reconciled Credit + True Accrual Profit -------------------------------------------------
def profit_range(events: list[Event], collect_alpha: float = 8.0, collect_beta: float = 2.0,
                 unsold_fraction: tuple[float, float] = (0.0, 0.3), samples: int = 2000) -> dict:
    """Accrual profit (rupees) as a range, from the *effective* (fused) events.

    profit = revenue - cost of stock actually used - expenses - receivables unlikely to be paid
    """
    rng = np.random.default_rng(RNG_SEED)

    revenue, purchases, expenses = [], [], []        # (amount_paise, confidence)
    receivable: dict[str, int] = defaultdict(int)
    for e in events:
        for p in e.postings:
            if p.account == "revenue:sales":
                revenue.append((-p.amount, e.confidence))
            elif p.account.startswith("inventory:") and e.kind == Kind.purchase:
                purchases.append((p.amount, e.confidence))
            elif p.account.startswith("expense:"):
                expenses.append((p.amount, e.confidence))
            elif p.account.startswith("receivable:"):
                receivable[p.account] += p.amount

    def noisy_sum(items: list[tuple[int, float]]) -> np.ndarray:
        """Each amount wobbles more the less sure we are about it."""
        if not items:
            return np.zeros(samples)
        amts = np.array([a for a, _ in items], dtype=float)
        sd = np.array([0.5 * (1 - c) for _, c in items])
        mult = np.clip(rng.normal(1.0, sd, size=(samples, len(items))), 0, None)
        return (mult * amts).sum(axis=1)

    rev = noisy_sum(revenue)
    buy = noisy_sum(purchases)
    exp = noisy_sum(expenses)
    unsold = rng.uniform(*unsold_fraction, size=samples)     # stock bought but not yet used
    cogs = buy * (1 - unsold)
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
    }
