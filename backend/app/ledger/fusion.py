"""Cross-modal fusion and conflict handling, computed as a pure *view* over the event log.

Why a view and not stored events: every device runs this on the same synced event set and gets the
same answer, so two devices can never emit two different "merge" events for the same evidence.
Only human decisions (settle a dispute, "these are separate", corrections) are stored as events.

Nothing here can tell a duplicate from a coincidence with certainty, so the rules are deliberately
narrow, every decision is reported (duplicates / conflicts / possible_conflicts), and a human can undo
any of them with a `separate` marker event (pipeline.separate):

1. Echo: the always-on mic cut one utterance twice -> same device, same source, back-to-back seq,
   identical words and amount. Counted once.
2. Cross-modal duplicate: the same trade seen by voice + SMS + tally -> different sources, identical
   kind/item/party/qty/amount, and either a few events apart on one device or recorded on different
   devices independently (concurrent). Counted once; confidence 1 - prod(1 - c_i).
3. Dispute: concurrent credit claims about one customer from different devices whose amounts look like
   the same figure misheard or miswritten (40 vs 400, 140 vs 410). The lower claim is booked,
   the difference waits in suspense; books stay balanced. Other concurrent pairs (40 vs 60) are counted
   as two separate payments and listed under possible_conflicts for a human glance.
"""
from dataclasses import dataclass, field

from app.ledger.events import Event, Kind, Posting
from app.ledger.store import causal_order
from app.sync import clock

SAME_DEVICE_WINDOW = 5        # cross-modal duplicates on one device: at most this many events apart
CREDIT_KINDS = (Kind.credit_paid, Kind.credit_given)


@dataclass
class FusionReport:
    effective: list[Event]                       # what the ledger should actually count
    duplicates: list[list[str]] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)
    possible_conflicts: list[dict] = field(default_factory=list)   # counted separately, worth a look


def _amount(e: Event) -> int:
    """Gross amount of an event in paise (sum of its debit side)."""
    return sum(p.amount for p in e.postings if p.amount > 0)


def _subject(e: Event) -> tuple:
    return (e.kind, e.payload.get("item"), (e.payload.get("party") or "").lower() or None)


def _same_trade(a: Event, b: Event) -> bool:
    return (_subject(a) == _subject(b) and _amount(a) == _amount(b)
            and a.payload.get("qty") == b.payload.get("qty"))


def _independent(a: Event, b: Event) -> bool:
    """Recorded close together on one device, or on two devices that hadn't synced in between."""
    if a.device_id == b.device_id:
        return abs(a.seq - b.seq) <= SAME_DEVICE_WINDOW
    return clock.concurrent(a.vclock, b.vclock)


def _echo(a: Event, b: Event) -> bool:
    return (a.device_id == b.device_id and a.source == b.source and abs(a.seq - b.seq) == 1
            and (a.raw or "").strip().lower() == (b.raw or "").strip().lower() != "" and _same_trade(a, b))


def misheard(x: int, y: int) -> bool:
    """Do two amounts look like one figure misheard / miswritten? Only two narrow patterns: an extra or
    missing zero (40 vs 400) and swapped digits (140 vs 410). 40 vs 60 is not one of them."""
    lo, hi = sorted((x, y))
    if lo <= 0 or lo == hi:
        return False
    if hi % lo == 0 and str(hi // lo).strip("0") == "1":          # 40 vs 400, 25 vs 2500
        return True
    a, b = str(lo // 100 if lo % 100 == 0 else lo), str(hi // 100 if hi % 100 == 0 else hi)
    return sorted(a) == sorted(b)                                # 140 vs 410


def _separated(events: list[Event]) -> set[frozenset[str]]:
    """Pairs a human marked as genuinely different trades."""
    out = set()
    for e in events:
        ids = e.payload.get("separate") or []
        out |= {frozenset((x, y)) for i, x in enumerate(ids) for y in ids[i + 1:]}
    return out


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
    separate = _separated(events)
    live = [e for e in causal_order(events) if e.id not in superseded and e.postings]
    no_postings = [e for e in events if e.id not in superseded and not e.postings]

    def allowed(a: Event, b: Event) -> bool:
        return frozenset((a.id, b.id)) not in separate

    used: set[str] = set()
    effective: list[Event] = []
    report = FusionReport(effective=effective)

    for i, a in enumerate(live):
        if a.id in used:
            continue

        # --- 1 + 2. echoes and cross-modal duplicates ----------------------------------------
        group = [a]
        for b in live[i + 1:]:
            if b.id in used or not all(allowed(g, b) for g in group):
                continue
            echo = _echo(group[-1], b)
            cross = b.source not in {g.source for g in group} and _same_trade(a, b) and _independent(a, b)
            if echo or cross:
                group.append(b)
        if len(group) > 1:
            ids = [g.id for g in group]
            used.update(ids)
            best = max(group, key=lambda g: (g.confidence, g.id))
            sources = {g.source for g in group}
            miss = 1.0
            for g in {g.source: g for g in group}.values():   # an echo is not independent evidence
                miss *= 1.0 - g.confidence
            conf = 1.0 - miss if len(sources) > 1 else best.confidence
            effective.append(_synthetic(ids, group, a.kind, best.postings, conf,
                                        {**best.payload, "evidence": [g.source.value for g in group]}))
            report.duplicates.append(ids)
            continue

        # --- 3. disputed credit claims ----------------------------------------------------------
        if a.kind in CREDIT_KINDS and a.payload.get("party"):
            rivals = [b for b in live[i + 1:]
                      if b.id not in used and b.device_id != a.device_id and _subject(b) == _subject(a)
                      and clock.concurrent(a.vclock, b.vclock) and _amount(a) != _amount(b) and allowed(a, b)]
            rival = next((b for b in rivals if misheard(_amount(a), _amount(b))), None)
            for b in rivals:
                if b is not rival:
                    report.possible_conflicts.append({"ids": [a.id, b.id], "party": a.payload["party"].lower(),
                                                      "kind": a.kind.value,
                                                      "claims_paise": sorted([_amount(a), _amount(b)]),
                                                      "counted_as": "two separate payments"})
            if rival is not None:
                lo, hi = sorted((a, rival), key=_amount)
                diff = _amount(hi) - _amount(lo)
                party = a.payload["party"].lower()
                receivable = f"receivable:{party}"
                postings = [Posting(account=p.account, amount=p.amount) for p in lo.postings]
                if a.kind == Kind.credit_paid:
                    postings += [Posting(account="suspense", amount=diff), Posting(account=receivable, amount=-diff)]
                else:
                    postings += [Posting(account=receivable, amount=diff), Posting(account="suspense", amount=-diff)]
                ids = [a.id, rival.id]
                used.update(ids)
                effective.append(_synthetic(ids, [a, rival], a.kind, postings,
                                            min(a.confidence, rival.confidence),
                                            {**lo.payload, "disputed_paise": diff}))
                report.conflicts.append({"ids": ids, "party": party, "kind": a.kind.value,
                                         "claims_paise": [_amount(lo), _amount(hi)], "suspense_paise": diff})
                continue

        used.add(a.id)
        effective.append(a)

    effective.extend(no_postings)
    return report
