import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.perception.slip_lines import parse_line, parse_slip
from app.perception.vision import Slip, SlipLine, _line_confidences, normalize

LEX = json.loads((Path(__file__).parent.parent / "data" / "lexicon.json").read_text(encoding="utf-8"))


# Line shapes taken from qwen3-vl:4b-instruct transcriptions of the real photos in eval/samples/slips
@pytest.mark.parametrize("text, item, qty, unit, amount", [
    ("Milk (2kg)", "milk", 2, "kg", None),
    ("Rice (200g)", "rice", 200, "g", None),
    ("Vanilla essence (10ml)", "vanilla essence", 10, "ml", None),
    ("1 Kg Baking Soda Powder", "baking soda powder", 1, "kg", None),
    ("2.5 Kg Refined Sugar", "refined sugar", 2.5, "kg", None),
    ("1 dozen Eggs", "eggs", 1, "dozen", None),
    ("Tomato (0.5 Kg)", "tomato", 0.5, "kg", None),
    ("Pistachio", "pistachio", None, None, None),
    ("Tamatar   5 kg    Rs 300", "tamatar", 5, "kg", 300),
    ("Poha 10kg = 550", "poha", 10, "kg", 550),
    ("Tel 1 L 160", "tel", 1, "l", 160),
    ("Dhaniya 1/2 kg ₹40", "dhaniya", 0.5, "kg", 40),
])
def test_parse_line(text, item, qty, unit, amount):
    p = parse_line(text)
    assert (p.item, p.qty, p.unit, p.amount_rupees) == (item, qty, unit, amount)


def test_second_quantity_is_kept_as_a_note():
    p = parse_line("Achaar (250g) (1 Bottle)")
    assert (p.item, p.qty, p.unit, p.notes) == ("achaar", 250, "g", ["1 Bottle"])


def test_slip_supplier_total_and_items():
    supplier, total, items = parse_slip(
        ["Shri Ganesh Traders", "", "Tamatar 5 kg Rs 300", "Pyaz 3 kg Rs 105", "-----", "Total Rs 405"])
    assert supplier == "Shri Ganesh Traders" and total == 405
    assert [p.item for _, p in items] == ["tamatar", "pyaz"]          # the total is not a purchase
    assert [i for i, _ in items] == [2, 3]                             # indexes point back to the text lines


def test_list_heading_is_not_a_supplier():
    supplier, _, items = parse_slip(["Kheer saaman", "Milk (2kg)", "Rice (200g)"])
    assert supplier is None and [p.item for _, p in items] == ["kheer saaman", "milk", "rice"]


def test_normalize_matches_lexicon_and_converts_units():
    raw = Slip(lines=[
        SlipLine(item="tamatar", qty=0.5, unit="kg", confidence=0.9),
        SlipLine(item="pyaaaz", qty=1, unit="kg", confidence=0.9),          # handwriting slip
        SlipLine(item="rice", qty=200, unit="g", confidence=0.9),
        SlipLine(item="vinegar", qty=700, unit="ml", confidence=0.9),
        SlipLine(item="hershey", qty=250, unit="ml", confidence=0.9),       # unknown: kept as read
    ])
    s = normalize(raw, LEX)
    assert [(l.item, l.qty, l.unit) for l in s.lines] == [
        ("tomato", 0.5, "kg"), ("onion", 1, "kg"), ("rice", 0.2, "kg"), ("vinegar", 0.7, "l"), ("hershey", 0.25, "l")]
    assert "matched 'pyaaz'" in s.lines[1].notes[0]


def test_line_confidence_is_driven_by_the_least_certain_digit():
    toks = [("Milk", -0.01), (" (", -0.01), ("2", -2.3), ("kg)", -0.02), ("\n", -0.01),
            ("Rice", -0.02), (" (", -0.01), ("200", -0.01), ("g)", -0.01)]
    confs = _line_confidences("Milk (2kg)\nRice (200g)", [SimpleNamespace(token=t, logprob=lp) for t, lp in toks])
    assert confs[0] < 0.15 and confs[1] > 0.95


def test_whisper_hotwords_are_local_names_without_units():
    from app.perception.lexicon import Lexicon
    words = Lexicon(Path(__file__).parent.parent / "data" / "lexicon.json").hotwords().split()
    assert {"pyaz", "bhindi", "tamatar", "chhotu"} <= set(words)
    assert not {"g", "gm", "ml", "ltr", "kg", "onion", "tomato"} & set(words)   # units made Whisper repeat them


def test_no_logprobs_means_unknown_not_confident():
    assert _line_confidences("Milk (2kg)", None) == [0.5]
