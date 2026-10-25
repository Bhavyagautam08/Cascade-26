"""Cross-modal fusion and conflict handling, computed as a pure *view* over the event log.

Why a view and not stored events: every device runs this on the same synced event set and gets the
same answer, so two devices can never emit two different "merge" events for the same evidence.
Only human decisions (e.g. resolving a suspense item) are stored as new events.

1. Duplicates: the same real-world event seen by voice + SMS + tally (different sources, same kind,
   same item/party, amount within tolerance, causally close) counts once. Confidence combines as
   independent evidence: 1 - prod(1 - c_i).
2. Conflicts: concurrent credit claims about the same party from different devices with different
   amounts (e.g. "Sharma paid 40" vs "Sharma paid 400"). The smaller amount is booked as certain;
   the disputed difference goes to `suspense` until a human resolves it. The books stay balanced.
"""
from dataclasses import dataclass, field

from app.ledger.events import Event, Kind, Posting
from app.ledger.store import causal_order
from app.sync import clock

AMOUNT_TOLERANCE = 0.05      # 5% difference still counts as "same amount"
CAUSAL_WINDOW = 6            # max difference in vector-clock sum to count as "same moment"
CREDIT_KINDS = (Kind.credit_paid, Kind.credit_given)


@dataclass
class FusionReport:
    effective: list[Event]                       # what the ledger should actually count
    duplicates: list[list[str]] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)


def _amount(e: Event) -> int:
    """Gross amount of an event in paise (sum of its debit side)."""
    return sum(p.amount for p in e.postings if p.amount > 0)


def _subject(e: Event) -> tuple:
    return (e.kind, e.payload.get("item"), (e.payload.get("party") or "").lower() or None)


def _close(a: Event, b: Event) -> bool:
    return abs(sum(a.vclock.values()) - sum(b.vclock.values())) <= CAUSAL_WINDOW


def _same_amount(a: Event, b: Event) -> bool:
    x, y = _amount(a), _amount(b)
    if x == 0 or y == 0:
        return x == y
    return abs(x - y) / max(x, y) <= AMOUNT_TOLERANCE


def _synthetic(ids: list[str], members: list[Event], kind: Kind, postings: list[Posting],
               confidence: float, payload: dict) -> Event:
    vc: dict[str, int] = {}
    for m in members:
        vc = clock.merge(vc, m.vclock)
    return Event(
        id="fused:" + "+".join(sorted(ids)), device_id="fusion", seq=0, vclock=vc, wall_time=None,
        kind=kind, source=members[0].source, confidence=min(confidence, 1.0), payload=payload,
        postings=postings, raw=" | ".join(m.raw or "" for m in members), supersedes=sorted(ids),
    )


def fuse(events: list[Event]) -> FusionReport:
    superseded = {sid for e in events for sid in e.supersedes}
    live = [e for e in causal_order(events) if e.id not in superseded and e.postings]
    no_postings = [e for e in events if e.id not in superseded and not e.postings]

    used: set[str] = set()
    effective: list[Event] = []
    report = FusionReport(effective=effective)

    for i, a in enumerate(live):
        if a.id in used:
            continue

        # --- 1. duplicates across different sources ------------------------------------------
        group = [a]
        for b in live[i + 1:]:
            if b.id in used or b.source in {g.source for g in group}:
                continue
            if _subject(b) == _subject(a) and _same_amount(a, b) and _close(a, b):
                group.append(b)
        if len(group) > 1:
            ids = [g.id for g in group]
            used.update(ids)
            best = max(group, key=lambda g: (g.confidence, g.id))
            miss = 1.0
            for g in group:
                miss *= 1.0 - g.confidence
            effective.append(_synthetic(ids, group, a.kind, best.postings, 1.0 - miss,
                                        {**best.payload, "evidence": [g.source.value for g in group]}))
            report.duplicates.append(ids)
            continue

        # --- 2. conflicting credit claims from different devices -----------------------------
        if a.kind in CREDIT_KINDS:
            rival = next(
                (b for b in live[i + 1:]
                 if b.id not in used and b.device_id != a.device_id and _subject(b) == _subject(a)
                 and clock.concurrent(a.vclock, b.vclock) and not _same_amount(a, b)),
                None,
            )
            if rival is not None:
                lo, hi = sorted((a, rival), key=_amount)
                diff = _amount(hi) - _amount(lo)
                party = (a.payload.get("party") or "unknown").lower()
                receivable = f"receivable:{party}"
                # certain part as the lower claim, disputed difference parked in suspense
                postings = [Posting(account=p.account, amount=p.amount) for p in lo.postings]
                if a.kind == Kind.credit_paid:
                    postings += [Posting(account="suspense", amount=diff),
                                 Posting(account=receivable, amount=-diff)]
                else:
                    postings += [Posting(account=receivable, amount=diff),
                                 Posting(account="suspense", amount=-diff)]
                ids = [a.id, rival.id]
                used.update(ids)
                effective.append(_synthetic(ids, [a, rival], a.kind, postings,
                                            min(a.confidence, rival.confidence),
                                            {**lo.payload, "disputed_paise": diff}))
                report.conflicts.append({"ids": ids, "party": party, "kind": a.kind.value,
                                         "claims_paise": [_amount(lo), _amount(hi)],
                                         "suspense_paise": diff})
                continue

        used.add(a.id)
        effective.append(a)

    effective.extend(no_postings)
    return report
