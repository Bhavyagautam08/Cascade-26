"""Cross-modal fusion, two-phone twins and disputes, computed as a pure *view* over the event log.

Why a view and not stored events: every device runs this on the same synced event set and gets the
same answer, so two devices can never emit two different "merge" events for the same evidence.
Only human decisions are stored as events: "these are one trade" (`same`), "these are separate"
(`separate`), settling a dispute, corrections. For a pair, the causally latest human decision wins.

Time between two entries, without trusting any wall clock (apart_s):
- one device, one run: both carry the device's monotonic clock (Event.mono) -> exact;
- two devices: every sync is a moment both phones noted, and each entry carries how many seconds after
  recent syncs it was recorded (Event.marks) -> for a shared sync, the difference is exact. If both
  phones were in touch but share no sync, the entries are far apart; if one wasn't in touch, unknown.
Words are NOT used to recognise one utterance heard by two phones: two transcripts of one utterance can
share almost no words (eval/twin_phones.py, eval/reports/2026-10-26_014456_twins.md). Time is used.

Rules. Each decision is reported (duplicates / conflicts / possible_*), and a person can undo any of them:
1. Echo: the mic cut one utterance twice -> same device and source, back to back, identical words and
   trade, within ECHO_S on the same run. Counted once.
2. Cross-modal: the same trade seen by voice + SMS + tally (different sources, identical trade): a few
   entries apart on one device, or on two devices within CROSS_MODAL_S (or, with no time known, devices
   that hadn't synced in between, on the same day). Counted once; confidence 1 - prod(1 - c_i).
3. Twins: two phones heard the same utterance -> different devices within TWIN_S, same kind, party and
   amount, same item or one has none. Counted once. Pairs are matched closest-first, one per device.
4. Disputes: one utterance heard with two amounts (two devices within TWIN_S), or concurrent udhaar
   claims of unknown timing whose amounts look misheard (40 vs 400, 140 vs 410). The lower claim is
   booked; for udhaar the difference waits in suspense. Other concurrent udhaar pairs of unknown timing
   (40 vs 60) count as two payments and are listed under possible_conflicts.
5. Possible duplicates: identical trades on two devices that were out of touch and hadn't synced in
   between, on the same day. Nothing can tell one trade from two, so both count and the pair is listed
   for a person to decide.
"""
from collections import defaultdict
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field

from app.ledger import days
from app.ledger.events import Event, Kind, Posting
from app.ledger.store import causal_order
from app.sync import clock

ECHO_S = 10.0             # one utterance cut twice by the mic: seconds apart. Repeats are also caught
                          # before booking (pipeline, VOICE_REPEAT_WINDOW_S); this is the backstop
TWIN_S = 30.0             # one utterance on two phones: the slower phone's speech + language model lag
                          # (~9 s measured here for a long utterance through the LLM), x3 for a slower phone
CROSS_MODAL_S = 300.0     # a spoken payment vs. its bank SMS: the SMS can arrive minutes later
SAME_DEVICE_WINDOW = 5    # cross-modal duplicates on one device: at most this many entries apart
CREDIT_KINDS = (Kind.credit_paid, Kind.credit_given)

EXACT, FAR, UNKNOWN = "exact", "far", "unknown"


@dataclass
class FusionReport:
    effective: list[Event]                       # what the ledger should actually count
    duplicates: list[list[str]] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)
    possible_conflicts: list[dict] = field(default_factory=list)    # counted separately, worth a look
    possible_duplicates: list[dict] = field(default_factory=list)   # counted separately, a person decides


def _amount(e: Event) -> int:
    """Gross amount of an event in paise (sum of its debit side)."""
    return sum(p.amount for p in e.postings if p.amount > 0)


def _party(e: Event) -> str | None:
    return (e.payload.get("party") or "").lower() or None


def _subject(e: Event) -> tuple:
    return (e.kind, e.payload.get("item"), _party(e))


def _same_trade(a: Event, b: Event) -> bool:
    return (_subject(a) == _subject(b) and _amount(a) == _amount(b)
            and a.payload.get("qty") == b.payload.get("qty"))


def _item_fits(a: Event, b: Event) -> bool:
    ia, ib = a.payload.get("item"), b.payload.get("item")
    return ia == ib or ia is None or ib is None


def concurrent(a: Event, b: Event) -> bool:
    """Neither had seen the other: recorded on devices that hadn't synced in between."""
    return clock.concurrent(a.vclock, b.vclock)


def evidence(a: Event, b: Event) -> tuple[str, float | None]:
    """How far apart a and b were recorded: (EXACT, seconds) | (FAR, None) | (UNKNOWN, None)."""
    if a.device_id == b.device_id:
        if a.mono and b.mono and a.mono[0] == b.mono[0]:
            return EXACT, abs(a.mono[1] - b.mono[1])
        return UNKNOWN, None                         # a restart in between, or entries from before Event.mono
    ma, mb = a.marks.get(b.device_id), b.marks.get(a.device_id)
    if not ma or not mb:
        return UNKNOWN, None                         # one of them had no recent sync with the other
    theirs = dict(mb)
    gaps = [abs(t - theirs[s]) for s, t in ma if s in theirs]
    return (EXACT, round(min(gaps), 3)) if gaps else (FAR, None)


def apart_s(a: Event, b: Event) -> float | None:
    return evidence(a, b)[1]


def _echo(a: Event, b: Event) -> bool:
    if not (a.device_id == b.device_id and a.source == b.source and abs(a.seq - b.seq) == 1
            and (a.raw or "").strip().lower() == (b.raw or "").strip().lower() != "" and _same_trade(a, b)):
        return False
    if a.mono and b.mono:                            # timed: the same run, seconds apart
        kind, t = evidence(a, b)
        return kind == EXACT and t <= ECHO_S
    return True                                      # entries from before Event.mono: back to back is all we know


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


def _decisions(events: list[Event]) -> dict[frozenset, str]:
    """{pair of ids: "same" | "separate"}: a person's decisions, the causally latest one per pair."""
    out: dict[frozenset, str] = {}
    for e in causal_order(events):
        for key in ("separate", "same"):
            ids = e.payload.get(key) or []
            for i, x in enumerate(ids):
                for y in ids[i + 1:]:
                    out[frozenset((x, y))] = key
    return out


def _pairs(evs: list[Event], key: Callable[[Event], tuple], day: dict[str, int],
           extra: set[frozenset]) -> Iterator[tuple[Event, Event]]:
    """Candidate pairs with equal key(), without comparing everything with everything:
    neighbours on one device, entries sharing a sync moment, entries of devices out of touch (same day),
    and pairs a person decided on. Each pair once, earlier entry first (in `evs` order)."""
    pos = {e.id: i for i, e in enumerate(evs)}
    seen: set[tuple[str, str]] = set()

    def emit(a: Event, b: Event):
        if a.id == b.id or key(a) != key(b):
            return None
        a, b = (a, b) if pos[a.id] < pos[b.id] else (b, a)
        if (a.id, b.id) in seen:
            return None
        seen.add((a.id, b.id))
        return a, b

    by_device: dict[str, list[Event]] = defaultdict(list)
    for e in evs:
        by_device[e.device_id].append(e)
    for lst in by_device.values():
        lst.sort(key=lambda e: e.seq)
        for i, a in enumerate(lst):
            for b in lst[i + 1:]:
                if b.seq - a.seq > SAME_DEVICE_WINDOW:
                    break
                if p := emit(a, b):
                    yield p

    by_moment: dict[str, list[Event]] = defaultdict(list)
    for e in evs:
        for marks in e.marks.values():
            for sid, _ in marks:
                by_moment[sid].append(e)
    for lst in by_moment.values():
        for i, a in enumerate(lst):
            for b in lst[i + 1:]:
                if a.device_id != b.device_id and (p := emit(a, b)):
                    yield p

    by_day: dict[tuple, list[Event]] = defaultdict(list)
    for e in evs:
        by_day[(key(e), day[e.id])].append(e)
    for lst in by_day.values():
        devices = {e.device_id for e in lst}
        if len(devices) < 2:
            continue
        for d1 in devices:
            for d2 in devices:
                if d1 >= d2:
                    continue
                one = [e for e in lst if e.device_id == d1]
                two = [e for e in lst if e.device_id == d2]
                lone1 = [e for e in one if not e.marks.get(d2)]
                lone2 = [e for e in two if not e.marks.get(d1)]
                for a in lone1:
                    for b in two:
                        if p := emit(a, b):
                            yield p
                for b in lone2:
                    for a in one:
                        if p := emit(a, b):
                            yield p

    by_id = {e.id: e for e in evs}
    for pair in extra:
        x, y = tuple(pair)
        if x in by_id and y in by_id and (p := emit(by_id[x], by_id[y])):
            yield p


def _duplicate_link(a: Event, b: Event, day: dict[str, int], said: str | None) -> tuple | None:
    """How strongly a and b are one trade (lower sorts first), or None. Same kind/party/amount assumed."""
    if said == "separate":
        return None
    if said == "same":
        return (0, 0.0)
    kind, t = evidence(a, b)
    if a.device_id == b.device_id:
        if (a.source != b.source and _same_trade(a, b) and abs(a.seq - b.seq) <= SAME_DEVICE_WINDOW
                and day[a.id] == day[b.id] and not (kind == EXACT and t > CROSS_MODAL_S)):
            return (1, t) if kind == EXACT else (2, float(abs(a.seq - b.seq)))
        return None
    if kind == EXACT:
        if t <= TWIN_S and _item_fits(a, b):
            return (1, t)
        if a.source != b.source and _same_trade(a, b) and t <= CROSS_MODAL_S:
            return (1, t)
        return None
    if (kind == UNKNOWN and a.source != b.source and _same_trade(a, b) and concurrent(a, b)
            and day[a.id] == day[b.id]):
        return (2, 0.0)
    return None


class _Groups:
    """Union-find over entries; a group holds at most one entry per (device, source), except echoes."""

    def __init__(self, evs: list[Event]):
        self.parent = {e.id: e.id for e in evs}
        self.members = {e.id: [e] for e in evs}

    def root(self, x: str) -> str:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def join(self, a: Event, b: Event, fits: Callable[[Event, Event], bool] | None) -> bool:
        ra, rb = self.root(a.id), self.root(b.id)
        if ra == rb:
            return False
        ma, mb = self.members[ra], self.members[rb]
        if fits is not None:
            if {(e.device_id, e.source) for e in ma} & {(e.device_id, e.source) for e in mb}:
                return False
            if not all(fits(x, y) for x in ma for y in mb):          # every member is the same trade
                return False
        self.parent[rb] = ra
        self.members[ra] = ma + self.members.pop(rb)
        return True


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


def _dispute(a: Event, b: Event, why: str) -> tuple[Event, dict]:
    lo, hi = sorted((a, b), key=_amount)
    diff = _amount(hi) - _amount(lo)
    party = _party(a)
    postings = [Posting(account=p.account, amount=p.amount) for p in lo.postings]
    suspense = 0
    if a.kind in CREDIT_KINDS and party:                          # udhaar: the gap waits in suspense
        receivable = f"receivable:{party}"
        if a.kind == Kind.credit_paid:
            postings += [Posting(account="suspense", amount=diff), Posting(account=receivable, amount=-diff)]
        else:
            postings += [Posting(account=receivable, amount=diff), Posting(account="suspense", amount=-diff)]
        suspense = diff
    ids = [a.id, b.id]
    ev = _synthetic(ids, [a, b], a.kind, postings, min(a.confidence, b.confidence),
                    {**lo.payload, "disputed_paise": diff})
    return ev, {"ids": ids, "party": party, "kind": a.kind.value, "item": a.payload.get("item") or b.payload.get("item"),
                "claims_paise": [_amount(lo), _amount(hi)], "booked_paise": _amount(lo), "disputed_paise": diff,
                "suspense_paise": suspense, "why": why}


def fuse(events: list[Event]) -> FusionReport:
    superseded = {sid for e in events for sid in e.supersedes}
    decided = _decisions(events)
    live = [e for e in causal_order(events) if e.id not in superseded and e.postings]
    no_postings = [e for e in events if e.id not in superseded and not e.postings]
    pos = {e.id: i for i, e in enumerate(live)}
    day = days.day_of_events(events)
    same_pairs = {p for p, d in decided.items() if d == "same"}

    def said(a: Event, b: Event) -> str | None:
        return decided.get(frozenset((a.id, b.id)))

    report = FusionReport(effective=[])
    groups = _Groups(live)
    money = (lambda e: (e.kind, _party(e), _amount(e)))

    # 1. echoes
    for a, b in _pairs(live, money, day, set()):
        if _echo(a, b) and said(a, b) != "separate":
            groups.join(a, b, fits=None)

    # 2 + 3. cross-modal duplicates and twins: the closest pairs first
    links = []
    for a, b in _pairs(live, money, day, same_pairs):
        strength = _duplicate_link(a, b, day, said(a, b))
        if strength is not None:
            links.append((strength, pos[a.id], pos[b.id], a, b))
    links.sort(key=lambda link: link[:3])

    def fits(x: Event, y: Event) -> bool:
        return _duplicate_link(x, y, day, said(x, y)) is not None or _echo(x, y)

    for *_, a, b in links:
        groups.join(a, b, fits)

    alone = [e for e in live if len(groups.members.get(groups.root(e.id), [])) == 1]

    # 4. disputes: one utterance, two amounts (closest first, one-to-one)
    subject = (lambda e: (e.kind, _party(e)))
    found, conflicts = [], []
    for a, b in _pairs(alone, subject, day, set()):
        x, y = _amount(a), _amount(b)
        if a.device_id == b.device_id or said(a, b) == "separate" or not _item_fits(a, b) or x == y or min(x, y) <= 0:
            continue
        kind, t = evidence(a, b)
        if kind == EXACT and t <= TWIN_S:
            found.append(((1, t), pos[a.id], pos[b.id], a, b, f"heard {t:g} s apart on two phones"))
        elif (kind == UNKNOWN and a.kind in CREDIT_KINDS and _party(a) and concurrent(a, b)
              and day[a.id] == day[b.id]):
            if misheard(x, y):
                found.append(((2, 0.0), pos[a.id], pos[b.id], a, b, "the amounts look like one figure misheard"))
            else:
                conflicts.append((a, b))
    found.sort(key=lambda f: f[:3])
    disputed: dict[str, Event] = {}
    for *_, a, b, why in found:
        if a.id in disputed or b.id in disputed:
            continue
        ev, c = _dispute(a, b, why)
        disputed[a.id] = disputed[b.id] = ev
        report.conflicts.append(c)
    for a, b in conflicts:
        if a.id not in disputed and b.id not in disputed:
            report.possible_conflicts.append({"ids": [a.id, b.id], "party": _party(a), "kind": a.kind.value,
                                              "claims_paise": sorted([_amount(a), _amount(b)]),
                                              "counted_as": "two separate payments"})

    # 5. possible duplicates: identical, out of touch, nothing to tell one from two (one-to-one)
    paired: set[str] = set()
    for a, b in _pairs([e for e in alone if e.id not in disputed], money, day, set()):
        if (a.id in paired or b.id in paired or a.device_id == b.device_id or said(a, b) is not None
                or not _same_trade(a, b) or not concurrent(a, b) or day[a.id] != day[b.id]
                or evidence(a, b)[0] != UNKNOWN):
            continue
        paired |= {a.id, b.id}
        report.possible_duplicates.append({
            "ids": [a.id, b.id], "kind": a.kind.value, "item": a.payload.get("item"), "party": _party(a),
            "qty": a.payload.get("qty"), "amount_paise": _amount(a), "devices": [a.device_id, b.device_id],
            "counted_as": "two trades",
            "why": "the two phones were out of touch, so one trade heard twice can't be told from two trades"})

    # the effective view, in causal order of each group's first entry
    done: set[str] = set()
    for e in live:
        if e.id in done:
            continue
        if e.id in disputed:
            ev = disputed[e.id]
            done.update(ev.supersedes)
            report.effective.append(ev)
            continue
        members = sorted(groups.members[groups.root(e.id)], key=lambda m: pos[m.id])
        done.update(m.id for m in members)
        if len(members) == 1:
            report.effective.append(e)
            continue
        ids = [m.id for m in members]
        best = max(members, key=lambda g: (g.confidence, g.id))
        sources = {g.source for g in members}
        miss = 1.0
        for g in {g.source: g for g in members}.values():          # one witness per source: an echo or a
            miss *= 1.0 - g.confidence                              # second phone's ear is not independent
        conf = 1.0 - miss if len(sources) > 1 else best.confidence
        report.effective.append(_synthetic(ids, members, e.kind, best.postings, conf,
                                           {**best.payload, "evidence": [g.source.value for g in members]}))
        report.duplicates.append(ids)

    report.effective.extend(no_postings)
    return report
