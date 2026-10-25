"""Turn candidate events into balanced postings, and compute balances."""
from collections import defaultdict

from app.ledger.events import CandidateEvent, Event, Kind, Posting


def rupees(x: float) -> int:
    return int(round(x * 100))


def postings_for(c: CandidateEvent) -> list[Posting]:
    """Map a candidate to balanced postings. Unknown amounts go nowhere yet (no postings)."""
    if c.amount_rupees is None:
        return []
    amt = rupees(c.amount_rupees)
    item = f"inventory:{c.item}" if c.item else "inventory:unknown"
    party = (c.party or "unknown").lower()

    match c.kind:
        case Kind.purchase:
            return [Posting(account=item, amount=amt), Posting(account="cash", amount=-amt)]
        case Kind.sale:
            return [Posting(account="cash", amount=amt), Posting(account="revenue:sales", amount=-amt)]
        case Kind.credit_given:
            return [Posting(account=f"receivable:{party}", amount=amt), Posting(account="revenue:sales", amount=-amt)]
        case Kind.credit_paid:
            return [Posting(account="cash", amount=amt), Posting(account=f"receivable:{party}", amount=-amt)]
        case Kind.expense:
            return [Posting(account=f"expense:{c.item or 'misc'}", amount=amt), Posting(account="cash", amount=-amt)]
        case _:
            return []


def balances(events: list[Event]) -> dict[str, int]:
    """Account balances in paise. Superseded events are excluded."""
    superseded = {sid for e in events for sid in e.supersedes}
    out: dict[str, int] = defaultdict(int)
    for e in events:
        if e.id in superseded:
            continue
        for p in e.postings:
            out[p.account] += p.amount
    return dict(out)


def trial_balance_ok(events: list[Event]) -> bool:
    return sum(balances(events).values()) == 0
