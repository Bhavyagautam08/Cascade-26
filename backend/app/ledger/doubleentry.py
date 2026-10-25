"""Turn candidate events into balanced postings, and compute balances.

Anything the evidence doesn't pin down goes to `suspense` (the accountant's "unclassified" account),
never to a made-up account: a purchase with no item, udhaar with no customer, bank money whose purpose
is unknown. Suspense is visible in the trial balance and is cleared by a human correction.
"""
from collections import defaultdict

from app.ledger.events import CandidateEvent, Event, Kind, Posting

SUSPENSE = "suspense"


def rupees(x: float) -> int:
    return int(round(x * 100))


def postings_for(c: CandidateEvent) -> list[Posting]:
    """Map a candidate to balanced postings. Unknown amounts post nothing (reported as incomplete)."""
    if c.amount_rupees is None:
        return []
    amt = rupees(c.amount_rupees)
    if amt <= 0:
        return []
    item = f"inventory:{c.item}" if c.item else SUSPENSE
    receivable = f"receivable:{c.party.lower()}" if c.party else SUSPENSE

    def pair(debit: str, credit: str) -> list[Posting]:
        return [Posting(account=debit, amount=amt), Posting(account=credit, amount=-amt)]

    match c.kind:
        case Kind.purchase:
            return pair(item, "cash")
        case Kind.sale:
            return pair("cash", "revenue:sales")
        case Kind.credit_given:
            return pair(receivable, "revenue:sales")
        case Kind.credit_paid:
            return pair("cash", receivable)
        case Kind.expense:
            return pair(f"expense:{c.item or 'misc'}", "cash")
        case Kind.adjustment if c.direction == "in":
            return pair("cash", SUSPENSE)
        case Kind.adjustment if c.direction == "out":
            return pair(SUSPENSE, "cash")
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


def incomplete(events: list[Event]) -> list[dict]:
    """Trades we heard about but couldn't put a number on. They don't touch the books, so a balanced
    trial balance says nothing about them; they are listed here instead of hidden."""
    superseded = {sid for e in events for sid in e.supersedes}
    money_kinds = {Kind.purchase, Kind.sale, Kind.credit_given, Kind.credit_paid, Kind.expense}
    return [{"id": e.id, "kind": e.kind.value, "item": e.payload.get("item"), "party": e.payload.get("party"),
             "raw": e.raw}
            for e in events if e.id not in superseded and e.kind in money_kinds and not e.postings]
