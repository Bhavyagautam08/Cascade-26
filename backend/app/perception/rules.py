"""Deterministic, lexicon-driven parser. Runs with no model at all.

Used as the fallback when the LLM is unavailable, and as a cross-check on LLM output. Because it
reads the lexicon on every call, a Lexicon Drop takes effect immediately.

Example: "Bhai 3 kilo tamatar liya 180 mein... Sharma ji ka 40 jama kar, aur 7 plate poha de."
  -> purchase tomato 3 kg Rs180 | credit_paid sharma Rs40 | sale poha 7 plate (priced from lexicon)
"""
import re

from app.ledger.events import CandidateEvent, Kind, Source

_CLAUSE_SPLIT = re.compile(r"[,.;!?…|\n]+|\s+aur\s+|\s+and\s+|\s+phir\s+")
_AMOUNT_MARKERS = ("mein", "me", "main", "rupay", "rupaye", "rs", "rupees", "ka", "ke")


def _phrase_find(text: str, phrases: list[str]) -> str | None:
    """Longest phrase from `phrases` occurring as whole words in text."""
    for p in sorted(phrases, key=len, reverse=True):
        if re.search(rf"(?<![\w]){re.escape(p)}(?![\w])", text):
            return p
    return None


def _numbers(tokens: list[str], words: dict[str, float]) -> list[tuple[int, float]]:
    out = []
    for i, t in enumerate(tokens):
        t2 = t.replace("₹", "").replace("rs", "") if t.startswith(("₹", "rs")) else t
        if re.fullmatch(r"\d+(\.\d+)?", t2):
            out.append((i, float(t2)))
        elif t in words:
            out.append((i, float(words[t])))
    return out


def parse(text: str, lex: dict, source: Source = Source.manual) -> list[CandidateEvent]:
    items: dict[str, str] = lex.get("items", {})
    item_words = {**items, **{v: v for v in items.values()}}
    units: dict[str, dict] = lex.get("units", {})
    aliases: dict[str, str] = lex.get("aliases", {})
    verbs: dict[str, str] = lex.get("verbs", {})
    numwords: dict[str, float] = lex.get("numbers", {})
    prices: dict[str, float] = lex.get("prices", {})

    events: list[CandidateEvent] = []
    for clause in _CLAUSE_SPLIT.split(text.lower()):
        clause = clause.strip()
        if not clause:
            continue
        tokens = re.findall(r"[\w₹.]+", clause)

        verb = _phrase_find(clause, list(verbs))
        item_key = _phrase_find(clause, list(item_words))
        unit_key = _phrase_find(clause, list(units))
        alias = _phrase_find(clause, list(aliases))
        party = aliases[alias] if alias else None
        if party is None:
            m = re.search(r"(\w+)\s+(?:ji|bhai|uncle|aunty)\s+(?:ka|ki|ke|ko|se)\b", clause)
            party = m.group(1) if m else None

        nums = _numbers(tokens, numwords)
        if not verb and not nums:
            continue  # chatter, not a transaction

        # A number right before the unit is a quantity; the rest are money.
        qty = amount = None
        unit_first = unit_key.split()[0] if unit_key else None
        for idx, val in nums:
            nxt = tokens[idx + 1] if idx + 1 < len(tokens) else ""
            if unit_first and nxt == unit_first and qty is None:
                qty = val * units[unit_key]["factor"]
            elif amount is None:
                amount = val
            elif nxt in _AMOUNT_MARKERS:
                amount = val

        kind = Kind(verbs[verb]) if verb else (Kind.credit_given if party and amount else None)
        if kind is None:
            continue
        item = item_words.get(item_key) if item_key else None

        confidence = 0.75
        if kind == Kind.sale and amount is None and item in prices and qty:
            amount = qty * float(prices[item])
            confidence = 0.6  # price inferred, not heard
        if amount is None:
            confidence = 0.4
        if kind in (Kind.credit_paid, Kind.credit_given) and not party:
            confidence = 0.35

        events.append(
            CandidateEvent(
                kind=kind, source=source, confidence=confidence, item=item, qty=qty,
                unit=units[unit_key]["unit"] if unit_key else None,
                amount_rupees=amount, party=party, raw=clause,
            )
        )
    return events
