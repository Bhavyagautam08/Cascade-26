"""Cross-modal fusion: the same real-world event heard by voice, seen in an SMS and written on a
tally must count once. Also: conflicting claims across devices go to a suspense account.

TODO(stage 4):
- match candidates by (kind, item/party, amount within tolerance, causal proximity)
- merge confidences (independent evidence -> 1 - prod(1 - c_i))
- emit an `adjustment` event that `supersedes` the duplicates
- credit conflicts (e.g. "Sharma paid 40" vs "Sharma paid 400"): post the difference to `suspense`
  until resolved by a newer event
"""
from app.ledger.events import Event


def find_duplicates(events: list[Event]) -> list[list[str]]:
    """Groups of event ids that describe the same real-world event."""
    return []


def find_conflicts(events: list[Event]) -> list[list[str]]:
    """Groups of concurrent events that make contradictory claims."""
    return []
