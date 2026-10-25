"""Turn a slip's transcribed lines into (item, qty, unit, amount) deterministically.

The vision model is good at *reading* handwriting and bad at deciding which number goes in which JSON
field (it put "(2kg)" into the item name and "2.5 kg" into the unit). So the model only transcribes;
this module does the structuring, and it is unit-tested on real transcriptions.

Handles the shapes seen on real slips:
  "Milk (2kg)"   "1 Kg Baking Soda Powder"   "Pyaaz (1 Kg)"   "Achaar (250g) (1 Bottle)"
  "Tamatar 5 kg Rs 300"   "Poha 10kg = 550"   "Total Rs 1115"   "Shri Ganesh Traders"
"""
import re
from dataclasses import dataclass, field

UNIT_WORDS = {
    "kg": "kg", "kgs": "kg", "kilo": "kg", "kilos": "kg", "kilogram": "kg", "kilograms": "kg",
    "g": "g", "gm": "g", "gms": "g", "gram": "g", "grams": "g", "gr": "g",
    "l": "l", "lt": "l", "ltr": "l", "ltrs": "l", "litre": "l", "litres": "l", "liter": "l", "liters": "l",
    "ml": "ml", "millilitre": "ml", "milliliter": "ml",
    "dozen": "dozen", "dz": "dozen",
    "pc": "piece", "pcs": "piece", "piece": "piece", "pieces": "piece",
    "packet": "packet", "packets": "packet", "pkt": "packet", "pack": "packet",
    "bottle": "bottle", "bottles": "bottle", "plate": "plate", "plates": "plate",
}
TOTAL_WORDS = ("grand total", "total", "kul", "jod", "yog")
_NUM = r"\d+(?:[.,]\d+)?(?:\s*/\s*\d+)?"
_UNIT = "|".join(sorted(map(re.escape, UNIT_WORDS), key=len, reverse=True))
QTY = re.compile(rf"(?<![\w.])({_NUM})\s*({_UNIT})(?![a-z])", re.I)
MONEY = re.compile(rf"(?:rs\.?|inr|₹|=|@)\s*({_NUM})|({_NUM})\s*(?:/-|rs\b|rupees?\b)", re.I)
BARE_NUM = re.compile(rf"(?<![\w.]){_NUM}(?![\w.])")


def _num(s: str) -> float:
    s = s.replace(",", ".").replace(" ", "")
    if "/" in s:
        a, b = s.split("/")
        return float(a) / float(b)
    return float(s)


@dataclass
class ParsedLine:
    item: str | None
    qty: float | None
    unit: str | None
    amount_rupees: float | None
    notes: list[str] = field(default_factory=list)
    is_total: bool = False


def parse_line(text: str) -> ParsedLine | None:
    """One transcribed line -> its parts. None for lines with no letters (decoration, dates, dashes)."""
    raw = text.strip().strip("-•*|").strip()
    if not re.search(r"[a-zA-Zऀ-ॿ]", raw):
        return None
    low = raw.lower()
    is_total = any(re.search(rf"\b{w}\b", low) for w in TOTAL_WORDS)

    rest = raw
    qty = unit = None
    notes: list[str] = []
    for m in QTY.finditer(raw):
        if qty is None:
            qty, unit = _num(m.group(1)), UNIT_WORDS[m.group(2).lower()]
        else:                                   # "(250g) (1 Bottle)": keep the extra as a note
            notes.append(m.group(0).strip())
        rest = rest.replace(m.group(0), " ", 1)

    amount = None
    m = MONEY.search(rest)
    if m:
        amount = _num(m.group(1) or m.group(2))
        rest = rest[:m.start()] + " " + rest[m.end():]
    else:                                       # "Tamatar 5 kg 300": a leftover bare number is the price
        nums = BARE_NUM.findall(rest)
        if nums:
            amount = _num(nums[-1])
            rest = BARE_NUM.sub(" ", rest)

    item = re.sub(r"[()\[\]{}:=₹/\\\-–—_]+", " ", rest)   # incl. en/em dashes: "Paneer — 500g"
    item = re.sub(r"\b(rs|inr|rupees?)\b\.?", " ", item, flags=re.I)
    item = re.sub(r"\s+", " ", item).strip(" .,").lower() or None
    return ParsedLine(item=item, qty=qty, unit=unit, amount_rupees=amount, notes=notes, is_total=is_total)


def parse_slip(lines: list[str]) -> tuple[str | None, float | None, list[tuple[int, ParsedLine]]]:
    """All lines -> (supplier, total, [(line index, parsed item line)]).

    The supplier is a heading line before the first item that has no quantity and no price.
    """
    supplier = total = None
    items: list[tuple[int, ParsedLine]] = []
    for i, text in enumerate(lines):
        p = parse_line(text)
        if p is None:
            bare = bare_amount(text)      # "565/-" under the items, with no "Total" word
            if bare is not None and items and total is None:
                total = bare
            continue
        if p.is_total:
            total = p.amount_rupees if p.amount_rupees is not None else total
            continue
        if not items and supplier is None and p.qty is None and p.amount_rupees is None and _looks_like_heading(text, lines, i):
            supplier = text.strip()
            continue
        items.append((i, p))
    return supplier, total, items


def bare_amount(text: str) -> float | None:
    """A line that is only money ("565/-", "Rs 565", "= 565"): how bills often write the total.
    A plain number without a money mark is not enough (it could be a date or a stray count)."""
    m = MONEY.fullmatch(text.strip())
    return _num(m.group(1) or m.group(2)) if m else None


def _looks_like_heading(text: str, lines: list[str], i: int) -> bool:
    """A heading is followed by item lines that do carry quantities or prices."""
    later = [parse_line(t) for t in lines[i + 1:]]
    return any(p and (p.qty is not None or p.amount_rupees is not None) for p in later) and \
        bool(re.search(r"(?i)\b(traders?|store|stores|kirana|mart|shop|enterprises?|& ?sons|bhandar|agency|wholesale|general)\b", text))
