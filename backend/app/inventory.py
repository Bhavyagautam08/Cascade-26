"""Morning voice inventory ("Start Your Day").

The vendor says what stock they have and what it cost, in Hindi / Hinglish:
  "Aaj subah mere paas 5 kilo tamatar hain, jo 200 rupaye ke khareede the. Do kilo aloo hain 80 rupaye
   ke, aur 100 puriyan hain jo 100 rupaye ki hain."
and gets a table to check, edit and save.

Division of labour, as in the rest of perception:
- The language model only reports what was SAID per item: the words, the quantity and unit as spoken,
  the money said, and whether the stock is already held or bought today.
- Code does everything that must not be guessed: spoken numbers -> digits, unit conversion via the
  lexicon, every quantity and price checked against the numbers actually in the transcript, unit cost
  only when both quantity and cost are known, and a question for every ambiguity.

Saving (confirm):
- Nothing is saved while a question is open (held or bought? how much? which unit?).
- A recording is identified by a hash of its audio (or of the typed text); saving the same one twice
  returns the first save instead of duplicating it - also across devices, since the check reads the
  synced event log.
- Today's confirmed stock is never overwritten silently: a second inventory that touches an item
  already confirmed today is refused (409) until the vendor says "replace"; the replacement supersedes
  the old entries, which stay in the log.
- Opening stock -> `opening_stock` events (stock vs an opening-balance account, not today's cash);
  bought today -> purchases (cash), or orders when no price was said (pipeline.as_recorded).
"""
import datetime as dt
import hashlib
import math
import re
from typing import Literal

from pydantic import BaseModel, Field

from app.ledger import days
from app.ledger.doubleentry import postings_for
from app.ledger.events import CandidateEvent, Event, Kind, Source
from app.perception import rules

HeardStatus = Literal["opening", "purchased", "unclear"]   # what the morning words can say
Status = Literal["opening", "purchased", "unclear", "closing"]   # "closing" = counted at the end of the day
Mode = Literal["opening", "closing"]                     # morning inventory | evening count


class InventoryItem(BaseModel):
    item: str
    said: str | None = None               # the words the vendor used for this item
    qty: float | None = None              # in `unit` (canonical: kg, l, piece, dozen, packet, ...)
    unit: str | None = None
    total_cost: float | None = None       # rupees paid for the whole quantity
    unit_cost: float | None = None        # rupees per unit, only when qty and total_cost are both known
    status: Status = "unclear"
    confidence: float = Field(0.5, ge=0, le=1)
    flags: list[str] = []
    question: str | None = None           # what the vendor must answer before saving


class Draft(BaseModel):
    recording_id: str
    transcript: str
    heard_confidence: float | None = None
    items: list[InventoryItem]
    open_questions: int
    already_saved: bool = False           # this exact recording was confirmed before
    asr: str | None = None
    reader: str | None = None


# --- what the model is asked for -----------------------------------------------------------------
class _LLMItem(BaseModel):
    said: str
    item: str
    qty: float | None = None
    unit: str | None = None
    total_cost: float | None = None
    status: HeardStatus


class _LLMOut(BaseModel):
    items: list[_LLMItem]


PROMPT = """A street vendor describes the stock they have this morning, in Hindi/English/Hinglish.
Return one entry per item mentioned. For each item:
- said: the exact words about this item.
- item: the item name, normalised with the lexicon if the word is in it (tamatar -> tomato), else as said.
- qty and unit: the number and unit word exactly as said, NOT converted ("500 gram" -> 500, "gram").
  A count of things with no unit ("100 puriyan") -> qty 100, unit "piece". No number said -> null.
- total_cost: rupees said for this item's whole quantity; null if no money was said for it.
- status: "opening" if the vendor already has it (hain, bacha hai, rakha hai, mere paas), even if it
  was bought earlier ("khareede the"); "purchased" if bought this morning/today (aaj liya, abhi laya,
  subah khareeda); "unclear" if you cannot tell.
Never invent a number. Spoken numbers come from the lexicon (sau = 100).

Example:
text: "mere paas 3 kilo pyaz hai 90 rupaye ka, aur aaj subah 2 litre doodh liya 120 mein, mirchi bhi hai"
{{"items": [{{"said": "3 kilo pyaz hai 90 rupaye ka", "item": "onion", "qty": 3, "unit": "kilo", "total_cost": 90, "status": "opening"}}, {{"said": "aaj subah 2 litre doodh liya 120 mein", "item": "milk", "qty": 2, "unit": "litre", "total_cost": 120, "status": "purchased"}}, {{"said": "mirchi bhi hai", "item": "chilli", "qty": null, "unit": null, "total_cost": null, "status": "opening"}}]}}

Lexicon: {lexicon}"""

CLOSING_PROMPT = """At the end of the day a street vendor says how much stock is LEFT, in Hindi/English/Hinglish.
Return one entry per item mentioned. For each item:
- said: the exact words about this item.
- item: the item name, normalised with the lexicon if the word is in it (tamatar -> tomato), else as said.
- qty and unit: the number and unit word exactly as said, NOT converted ("500 gram" -> 500, "gram").
  A count of things with no unit ("20 puriyan") -> qty 20, unit "piece". "khatam" / nothing left -> qty 0.
  No number said -> null.
- total_cost: null. status: "opening".
Never invent a number. Spoken numbers come from the lexicon (sau = 100).

Example:
text: "shaam ko 2 kilo pyaz bacha hai, doodh khatam, aur mirchi thodi si hai"
{{"items": [{{"said": "2 kilo pyaz bacha hai", "item": "onion", "qty": 2, "unit": "kilo", "total_cost": null, "status": "opening"}}, {{"said": "doodh khatam", "item": "milk", "qty": 0, "unit": null, "total_cost": null, "status": "opening"}}, {{"said": "mirchi thodi si hai", "item": "chilli", "qty": null, "unit": null, "total_cost": null, "status": "opening"}}]}}

Lexicon: {lexicon}"""

COUNT_UNITS = {"piece", "pieces", "pc", "pcs", "nag", "number"}
_NONE_LEFT = {"khatam", "nahi", "nahin", "zero", "nothing"}

# Held-or-bought must come from the words, not from the model's guess. Measured: the model called
# "mere paas 5 kilo tamatar hain, jo 200 rupaye ke khareede the" (have; bought earlier) "purchased",
# and gave a verb-less "tamatar 4 kilo, 160 rupaye" a status instead of asking.
_BUY = {"liya", "liye", "li", "laya", "laye", "layi", "lae", "khareeda", "khareede", "khareedi", "kharida", "kharide",
        "kharidi", "mangwaya", "mangwaye", "bought"}
_EARLIER = {"tha", "the", "thi"}          # "khareede the" = had been bought: it is stock already held
_HAVE = {"hai", "hain", "pada", "padi", "pade", "bacha", "bachi", "bache", "rakha", "rakhi", "rakhe", "paas",
         "pehle", "kal"}


_MONEY = re.compile(r"(?:₹|rs\.?|inr)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:rupaye|rupay|rupees?|rs\b|/-)", re.I)


def _money_in(said: str) -> list[float]:
    """Amounts explicitly marked as money in these words ("200 rupaye", "₹200", "Rs 200", "200/-")."""
    return [float(a or b) for a, b in _MONEY.findall(said or "")]


def status_from_words(said: str) -> Status:
    w = re.findall(r"[a-z]+", said.lower())
    for k, t in enumerate(w):
        if t in _BUY and not (k + 1 < len(w) and w[k + 1] in _EARLIER):
            return "purchased"
    return "opening" if _HAVE & set(w) else "unclear"


def recording_id(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:24]


def extract(client, model: str, transcript: str, lex: dict, mode: Mode = "opening") -> list[InventoryItem]:
    """Transcript -> checked inventory items (never guesses; flags and questions instead)."""
    import json
    said_text = rules.spoken_numbers(transcript, lex)
    prompt = PROMPT if mode == "opening" else CLOSING_PROMPT
    r = client.chat(
        model=model,
        messages=[{"role": "system", "content": prompt.format(lexicon=json.dumps(lex, ensure_ascii=False))},
                  {"role": "user", "content": f"text: {said_text}"}],
        format=_LLMOut.model_json_schema(), options={"temperature": 0, "num_predict": 1536}, think=False)
    out = _LLMOut.model_validate_json(r.message.content)
    return [check(i, said_text, lex, mode) for i in out.items]


def _questions(name: str, qty: float | None, unit: str | None, status: str) -> list[str]:
    q = []
    if qty is None:
        q.append(f"How much {name} is there?")
    elif unit is None and qty != 0:                     # zero needs no unit: nothing left is nothing left
        q.append(f"{qty:g} of {name} - kilo, litre, or pieces?")
    if status == "unclear":
        q.append(f"Did you buy the {name} this morning, or was it already with you?")
    return q


def check(raw: _LLMItem, transcript: str, lex: dict, mode: Mode = "opening") -> InventoryItem:
    """Hold the model to the words actually said, convert units, compute unit cost, ask what's missing.
    Evening counts (mode="closing") only need what is left: no price, no held-or-bought question."""
    numwords = lex.get("numbers", {})
    heard = rules.numbers_in(transcript, numwords) | rules.numbers_in(raw.said, numwords)
    if mode == "closing" and _NONE_LEFT & set(re.findall(r"[a-z]+", raw.said.lower())):
        heard |= {0.0}                                  # "doodh khatam" says zero without a digit
    flags: list[str] = []
    name = (raw.item or raw.said).strip().lower()

    qty = raw.qty
    if qty is not None and not any(math.isclose(qty, h, rel_tol=1e-6, abs_tol=1e-9) for h in heard):
        flags.append(f"quantity_not_heard:{qty:g}")
        qty = None
    if mode == "closing":
        unit, qty = _unit(raw.unit, qty, lex, flags)
        return InventoryItem(item=name, said=raw.said, qty=qty, unit=unit, status="closing",
                             confidence=1.0 if not flags and qty is not None else 0.5, flags=flags,
                             question=" ".join(_questions(name, qty, unit, "closing")) or None)
    questions: list[str] = []
    cost = raw.total_cost
    if cost is not None and not any(math.isclose(cost, h, rel_tol=1e-6) for h in heard):
        flags.append(f"cost_not_heard:{cost:g}")
        cost = None
    if cost is None and raw.total_cost is None:
        # The model left out a price that is in this item's own words (measured: "5 kilo tamatar hain, jo
        # 200 rupaye ke khareede the" -> no cost, every run). Taken only when exactly one money amount is there.
        money = _money_in(raw.said)
        if len(money) == 1:
            cost = money[0]
            flags.append("cost_from_words")

    unit, qty = _unit(raw.unit, qty, lex, flags)
    status = status_from_words(raw.said)
    if status != raw.status:
        flags.append(f"status_from_words:{raw.status}->{status}")
    questions += _questions(name, qty, unit, status)
    if cost is None:
        flags.append("cost_missing")                   # allowed, but visible: nothing is assumed

    unit_cost = round(cost / qty, 4) if cost is not None and qty else None
    conf = 1.0 if not flags and not questions else (0.5 if questions else 0.75)
    return InventoryItem(item=name, said=raw.said, qty=qty, unit=unit, total_cost=cost, unit_cost=unit_cost,
                         status=status, confidence=conf, flags=flags,
                         question=" ".join(questions) or None)


def _unit(said_unit: str | None, qty: float | None, lex: dict, flags: list[str]) -> tuple[str | None, float | None]:
    """Spoken unit -> canonical unit via the lexicon, converting the quantity with it."""
    unit = (said_unit or "").strip().lower() or None
    units = {k.lower(): v for k, v in lex.get("units", {}).items()}
    if unit in units:
        u = units[unit]
        return u["unit"], (round(qty * u["factor"], 6) if qty is not None else None)
    if unit in COUNT_UNITS:
        return "piece", qty
    if unit is not None:
        flags.append(f"unknown_unit:{unit}")          # kept as said, not converted
    return unit, qty


def recheck(item: InventoryItem, mode: Mode = "opening") -> InventoryItem:
    """After the vendor edits a row: recompute unit cost and what is still open."""
    status = "closing" if mode == "closing" else item.status
    questions = _questions(item.item, item.qty, item.unit or None, status)
    unit_cost = (round(item.total_cost / item.qty, 4)
                 if mode == "opening" and item.total_cost is not None and item.qty else None)
    return item.model_copy(update={"unit_cost": unit_cost, "status": status, "question": " ".join(questions) or None})


# --- saving ------------------------------------------------------------------------------------------
class NeedsAnswers(ValueError):
    def __init__(self, items: list[InventoryItem]):
        self.items = items
        super().__init__("answer the open questions before saving: " + "; ".join(i.question or "" for i in items))


class WouldOverwrite(ValueError):
    def __init__(self, existing: list[dict]):
        self.existing = existing
        super().__init__("already saved today: " + ", ".join(e["item"] for e in existing))


def saved(events: list[Event], rec_id: str) -> list[Event]:
    superseded = {s for e in events for s in e.supersedes}
    return [e for e in events if e.payload.get("recording_id") == rec_id and e.id not in superseded]


def todays_inventory(events: list[Event], mode: Mode = "opening", day: int | None = None) -> list[Event]:
    """The morning inventory (mode="opening") or the evening count ("closing") saved in a business day
    (default: the current one). Days come from day markers, never from a phone's clock."""
    day = days.current_day(events) if day is None else day
    superseded = {s for e in events for s in e.supersedes}
    return [e for e in days.in_day(events, day)
            if e.payload.get("inventory") == mode and e.id not in superseded]


def confirm(store, rec_id: str, transcript: str, items: list[InventoryItem], source: Source,
            replace: bool = False, mode: Mode = "opening") -> dict:
    from app.pipeline import as_recorded

    with store._lock:                               # check-then-write atomically (two taps of Save)
        events = store.all()
        already = saved(events, rec_id)
        if already:                                   # same recording saved before: no duplicates
            return {"duplicate": True, "events": [e.model_dump(mode="json") for e in already]}

        items = [recheck(i, mode) for i in items]
        open_ = [i for i in items if i.question or not i.item.strip()]
        if open_:
            raise NeedsAnswers(open_)

        clash = [e for e in todays_inventory(events, mode) if e.payload.get("item") in {i.item for i in items}]
        if clash and not replace:
            raise WouldOverwrite([{"id": e.id, "item": e.payload.get("item"), "qty": e.payload.get("qty"),
                                   "unit": e.payload.get("unit"), "kind": e.kind.value} for e in clash])

        created = []
        for i in items:
            replaced = [e.id for e in clash if e.payload.get("item") == i.item]
            common = {"recording_id": rec_id, "inventory": mode, "said": i.said}
            if mode == "closing":                     # what is left: a stock count, no money moves
                payload = {"item": i.item, "qty": i.qty, "unit": i.unit, "closing": True, "flags": i.flags, **common}
                ev = store.append_local(kind=Kind.stock_count, source=source, postings=[], payload=payload,
                                        confidence=1.0, raw=transcript, supersedes=replaced)
            else:
                kind = Kind.opening_stock if i.status == "opening" else Kind.purchase
                cand = as_recorded(CandidateEvent(kind=kind, source=source, confidence=1.0, item=i.item, qty=i.qty,
                                                  unit=i.unit, amount_rupees=i.total_cost, flags=list(i.flags)))
                payload = {**cand.model_dump(exclude={"kind", "source", "raw", "confidence"}),
                           "unit_cost": i.unit_cost, **common}
                ev = store.append_local(kind=cand.kind, source=source, postings=postings_for(cand), payload=payload,
                                        confidence=1.0, raw=transcript, supersedes=replaced)
            created.append(ev.model_dump(mode="json"))
        return {"duplicate": False, "events": created, "replaced": [e.id for e in clash]}
