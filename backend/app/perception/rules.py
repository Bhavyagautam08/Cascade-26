"""Deterministic, lexicon-driven parser. Runs with no model at all.

Used as the fallback when the LLM is unavailable, and to cross-check the LLM's amounts
(pipeline.cross_check). Because it reads the lexicon on every call, a Lexicon Drop takes effect
immediately.

Example: "Bhai 3 kilo tamatar liya 180 mein... Sharma ji ka 40 jama kar, aur 7 plate poha de."
  -> purchase tomato 3 kg Rs180 | credit_paid sharma Rs40 | sale poha 7 plate (priced from list, flagged)

Rules, in order of trust:
- A number word ("do", "saat") is only a number next to a unit, item, money word or "sau"/"hazaar",
  because the same words are verbs and fillers ("de do" = give).
- Numbers followed by a time word ("2 baje") are times, not money.
- A number right before a unit or an item is a quantity; the rest are money candidates. If more than one
  candidate remains and markers ("mein", "Rs", "ka") don't single one out, the amount is left unknown
  rather than guessed.
- A clause without a verb takes the verb of the previous clause ("pyaz laya 80 aur aloo 30"); with no
  previous verb it is returned as unparsed instead of being dropped or guessed.
- "X ko 50 diya" (money handed to a person, no item) is an unclassified outflow, not a sale.
"""
import re
from dataclasses import dataclass, field

from app.ledger.events import CandidateEvent, Kind, Source

_CLAUSE_SPLIT = re.compile(r"[,.;!?…|\n]+|\s+aur\s+|\s+and\s+|\s+phir\s+")
_MONEY_AFTER = {"mein", "me", "main", "rupay", "rupaye", "rupee", "rupees", "rs", "ka", "ke", "ki"}
_MONEY_BEFORE = {"rs", "₹", "inr", "ka", "ke", "ki"}
_TIME_WORDS = {"baje", "bje", "bajkar", "minute", "min", "mins", "ghanta", "ghante", "din", "tarikh", "tareekh",
               "saal", "am", "pm", "o'clock"}
_MULTIPLIERS = {"sau": 100, "hazaar": 1000, "hazar": 1000}
_HONORIFIC = r"(?:\s+(?:ji|bhai|uncle|aunty|didi|bhaiya))?"

# Confidence of a rule-parsed event. Not calibrated: ordering only (heard > inferred > guessed).
CONF_HEARD = 0.75
CONF_VERB_INHERITED = 0.6
CONF_PRICED_FROM_LIST = 0.5
CONF_NO_AMOUNT = 0.4
CONF_NO_PARTY = 0.35
CONF_AMBIGUOUS = 0.3


@dataclass
class ParseResult:
    events: list[CandidateEvent] = field(default_factory=list)
    unparsed: list[str] = field(default_factory=list)   # clauses with numbers we couldn't classify


def _phrase_find(text: str, phrases) -> str | None:
    """Longest phrase from `phrases` occurring as whole words in text."""
    for p in sorted(phrases, key=len, reverse=True):
        if re.search(rf"(?<![\w]){re.escape(p)}(?![\w])", text):
            return p
    return None


def _tokens(clause: str) -> list[str]:
    return re.findall(r"₹|[a-z']+|\d+(?:\.\d+)?|[\w.]+", clause)


_SAY_AFTER = {"mein", "me", "main", "rupay", "rupaye", "rupee", "rupees", "rs"}


def spoken_numbers(text: str, lex: dict) -> str:
    """Write spoken numbers as digits where a unit or money word follows, before any parsing:
    "soo gram mirchi" -> "100 gram mirchi", "dhai sau gram" -> "250 gram", "ek sau assi mein" -> "180 mein".

    The LLM mis-read "soo gram" as 0.5 kg (eval audio 101) even with the lexicon in its prompt. Number
    words are also verbs and fillers ("de do" = give), so a word is converted only when a unit or money
    word comes right after the number phrase.
    """
    numwords = {k: float(v) for k, v in lex.get("numbers", {}).items() if " " not in k}
    mult = {**_MULTIPLIERS, **{k: float(v) for k, v in lex.get("numbers", {}).items() if v in (100, 1000) and " " not in k}}
    units = {k.split()[0] for k in lex.get("units", {})} | _SAY_AFTER
    toks = list(re.finditer(r"\S+", text))
    word = lambda k: toks[k].group(0).lower().strip(".,;!?()")  # noqa: E731
    spans: list[tuple[int, int, str]] = []
    i = 0
    while i < len(toks):
        j, val, cur = i, 0.0, None
        while j < len(toks):                 # "ek | sau | assi", "dhai | sau", "soo"
            w = word(j)
            if w in mult and cur is not None:
                cur *= mult[w]
            elif w in numwords and (cur is None or cur >= 100):   # "teen chaar" is two numbers, not one
                val, cur = val + (cur or 0.0), numwords[w]
            else:
                break
            j += 1
        if cur is not None and j < len(toks) and word(j) in units:
            spans.append((toks[i].start(), toks[j - 1].end(), f"{val + cur:g}"))
            i = j
        else:
            i += 1
    out, pos = [], 0
    for start, end, digits in spans:
        out += [text[pos:start], digits]
        pos = end
    return "".join(out) + text[pos:]


def numbers_in(text: str, numwords: dict[str, float]) -> set[float]:
    """Every number literally present in text (digits, number words, "do sau"), for cross-checking."""
    out: set[float] = set()
    toks = _tokens(text.lower().replace(",", ""))
    for i, t in enumerate(toks):
        if re.fullmatch(r"\d+(?:\.\d+)?", t):
            out.add(float(t))
        elif t in numwords:
            v = float(numwords[t])
            out.add(v)
            if i + 1 < len(toks) and toks[i + 1] in _MULTIPLIERS:
                out.add(v * _MULTIPLIERS[toks[i + 1]])
        elif t in _MULTIPLIERS:
            out.add(float(_MULTIPLIERS[t]))
    return out


def _numbers(tokens: list[str], numwords: dict[str, float], context: set[str]) -> list[tuple[int, float]]:
    """(index, value) of numbers that are really numbers here. `context` = unit/item first words."""
    out, skip = [], set()
    for i, t in enumerate(tokens):
        if i in skip:
            continue
        nxt = tokens[i + 1] if i + 1 < len(tokens) else ""
        if re.fullmatch(r"\d+(?:\.\d+)?", t):
            val = float(t)
        elif t in numwords and (nxt in context or nxt in _MONEY_AFTER or nxt in _MULTIPLIERS):
            val = float(numwords[t])
        else:
            continue
        if nxt in _MULTIPLIERS:
            val *= _MULTIPLIERS[nxt]
            skip.add(i + 1)
            nxt = tokens[i + 2] if i + 2 < len(tokens) else ""
        if nxt in _TIME_WORDS:
            continue
        out.append((i, val))
    return out


def _party(clause: str, aliases: dict[str, str], not_people: set[str]) -> tuple[str | None, bool]:
    """(party, is_recipient). Recipient = "X ko ..." (something handed to X)."""
    alias = _phrase_find(clause, aliases)
    m_to = re.search(rf"(\w+){_HONORIFIC}\s+ko\b", clause)
    if alias:
        recipient = bool(re.search(rf"{re.escape(alias)}\s+ko\b", clause))
        return aliases[alias], recipient
    m = re.search(rf"(\w+){_HONORIFIC}\s+(?:ka|ki|ke|se)\b", clause)
    def person(w: str) -> bool:     # "gas ka 300", "do sau ka", "40 ka" are not customers
        return w not in not_people and w not in _MULTIPLIERS and not re.fullmatch(r"\d.*", w)
    if m and person(m.group(1)):
        return m.group(1), False
    if m_to and person(m_to.group(1)):
        return m_to.group(1), True
    return None, False


def parse_detailed(text: str, lex: dict, source: Source = Source.manual) -> ParseResult:
    items: dict[str, str] = lex.get("items", {})
    item_words = {**items, **{v: v for v in items.values()}}
    units: dict[str, dict] = lex.get("units", {})
    aliases: dict[str, str] = lex.get("aliases", {})
    verbs: dict[str, str] = lex.get("verbs", {})
    numwords: dict[str, float] = lex.get("numbers", {})
    prices: dict[str, float] = lex.get("prices", {})
    context = {u.split()[0] for u in units} | {w.split()[0] for w in item_words}
    not_people = set(item_words) | set(units) | set(verbs) | set(numwords)

    result = ParseResult()
    last_kind: Kind | None = None
    for clause in _CLAUSE_SPLIT.split(text.lower()):
        clause = clause.strip()
        if not clause:
            continue
        tokens = _tokens(clause)
        verb = _phrase_find(clause, verbs)
        item_key = _phrase_find(clause, item_words)
        unit_key = _phrase_find(clause, units)
        party, recipient = _party(clause, aliases, not_people)
        nums = _numbers(tokens, numwords, context)
        if not verb and not nums:
            continue  # chatter, not a transaction

        flags: list[str] = []
        kind = Kind(verbs[verb]) if verb else None
        if kind is None and last_kind is not None and nums:
            kind, flags = last_kind, ["verb_inherited"]
        if kind is None:
            result.unparsed.append(clause)
            continue
        last_kind = kind

        # Quantity: number right before the unit (or before the item when no unit is said).
        qty, unit = None, None
        unit_first = unit_key.split()[0] if unit_key else None
        item_first = item_key.split()[0] if item_key else None
        money: list[tuple[int, float]] = []
        for idx, val in nums:
            nxt = tokens[idx + 1] if idx + 1 < len(tokens) else ""
            if nxt in _MULTIPLIERS:
                nxt = tokens[idx + 2] if idx + 2 < len(tokens) else ""
            if qty is None and unit_first and nxt == unit_first:
                qty, unit = val * units[unit_key]["factor"], units[unit_key]["unit"]
            elif qty is None and not unit_first and item_first and nxt == item_first:
                qty = val
            else:
                money.append((idx, val))
        if qty is None and unit_key and " " in unit_key:          # "aadha kilo" carries its own number
            qty, unit = units[unit_key]["factor"], units[unit_key]["unit"]

        amount = None
        if len(money) == 1:
            amount = money[0][1]
        elif len(money) > 1:
            def marked(i: int) -> bool:
                prev = tokens[i - 1] if i > 0 else ""
                nxt = tokens[i + 1] if i + 1 < len(tokens) else ""
                return prev in _MONEY_BEFORE or nxt in _MONEY_AFTER
            picks = [v for i, v in money if marked(i)]
            if len(picks) == 1:
                amount = picks[0]
            else:
                flags.append("ambiguous_amount")

        item = item_words.get(item_key) if item_key else None
        direction = None
        if kind == Kind.sale and recipient and item is None:      # "sharma ji ko 50 diya": money out, purpose unknown
            kind, direction = Kind.adjustment, "out"
            flags.append("unclassified_outflow")

        confidence = CONF_VERB_INHERITED if "verb_inherited" in flags else CONF_HEARD
        if kind == Kind.sale and amount is None and item in prices and qty and "ambiguous_amount" not in flags:
            amount = qty * float(prices[item])
            confidence = min(confidence, CONF_PRICED_FROM_LIST)
            flags.append("priced_from_list")
        if amount is None and kind not in (Kind.stock_count, Kind.order):   # these have no amount by nature
            confidence = min(confidence, CONF_NO_AMOUNT)
        if "ambiguous_amount" in flags:
            confidence = CONF_AMBIGUOUS
        if kind in (Kind.credit_paid, Kind.credit_given) and not party:
            confidence = min(confidence, CONF_NO_PARTY)
            flags.append("no_party")

        result.events.append(CandidateEvent(
            kind=kind, source=source, confidence=confidence, item=item, qty=qty, unit=unit,
            amount_rupees=amount, party=party, direction=direction, flags=flags, raw=clause,
        ))
    return result


def parse(text: str, lex: dict, source: Source = Source.manual) -> list[CandidateEvent]:
    return parse_detailed(text, lex, source).events
