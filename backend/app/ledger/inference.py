"""Probabilistic layer: recipe inference, loss attribution, ranges.

Evaluation chain: Raw Material Burn -> Inferred Wastage -> Reconciled Credit -> True Accrual Profit

TODO(stage 5):
- recipe_per_plate: non-negative least squares (scipy.optimize.nnls) of ingredient burn vs plates sold
- attribute_loss: unexplained stock loss split into spoilage / theft / personal use using priors
  shifted by covariates (temperature, unattended hours, family members present)
- profit_range: Monte Carlo over uncertain quantities -> (p10, p50, p90)
"""
import numpy as np

from app.ledger.events import Event


def recipe_per_plate(burn: np.ndarray, plates: np.ndarray) -> np.ndarray:
    """burn: days x ingredients consumed, plates: days x dishes sold -> dishes x ingredients usage."""
    raise NotImplementedError


def attribute_loss(unexplained_kg: float, covariates: dict) -> dict[str, float]:
    """Probability distribution over {spoilage, theft, personal}."""
    return {"spoilage": 1 / 3, "theft": 1 / 3, "personal": 1 / 3}


def profit_range(events: list[Event], samples: int = 2000) -> dict[str, float]:
    """True accrual profit as a range (rupees)."""
    return {"p10": 0.0, "p50": 0.0, "p90": 0.0}
