import json
from pathlib import Path

from app.perception.vision import Slip, SlipLine, normalize

LEX = json.loads((Path(__file__).parent.parent / "data" / "lexicon.json").read_text(encoding="utf-8"))


def test_total_row_is_not_a_purchase_and_names_match_the_ledger():
    # What qwen3-vl:4b-instruct actually returned for a 4-line bill before this clean-up existed
    raw = Slip(supplier=None, total_rupees=None, lines=[
        SlipLine(item="Tamatar", qty=5, unit="kg", amount_rupees=300, confidence=0.98),
        SlipLine(item="Tel", qty=1, unit="L", amount_rupees=160, confidence=0.98),
        SlipLine(item="paav mirchi", qty=2, unit="paav", amount_rupees=40, confidence=0.6),
        SlipLine(item="Total", qty=None, unit=None, amount_rupees=1115, confidence=0.98),
    ])
    s = normalize(raw, LEX)
    assert [l.item for l in s.lines] == ["tomato", "oil", "paav mirchi"]   # unknown names kept, lowercased
    assert s.total_rupees == 1115                                          # total moved off the lines
    assert s.lines[1].unit == "l"
    assert s.lines[2].unit == "kg" and s.lines[2].qty == 0.5                # 2 paav = 0.5 kg


def test_written_total_wins_over_a_total_row():
    raw = Slip(total_rupees=500, lines=[SlipLine(item="kul", amount_rupees=480, confidence=0.9)])
    assert normalize(raw, LEX).total_rupees == 500 and normalize(raw, LEX).lines == []
