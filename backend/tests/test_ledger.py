import json
from pathlib import Path

import numpy as np

from app.ledger import inference
from app.ledger.doubleentry import balances, postings_for, trial_balance_ok
from app.ledger.events import Kind, Source
from app.ledger.fusion import fuse
from app.ledger.store import EventStore
from app.perception import rules

LEX = json.loads((Path(__file__).parent.parent / "data" / "lexicon.json").read_text(encoding="utf-8"))
PS_SENTENCE = "Bhai 3 kilo tamatar liya 180 mein… Sharma ji ka 40 jama kar, aur 7 plate poha de."


def _add(store: EventStore, text: str, source: Source):
    out = []
    for c in rules.parse(text, LEX, source):
        out.append(store.append_local(c.kind, c.source, postings_for(c),
                                      payload=c.model_dump(exclude={"kind", "source", "raw", "confidence"}),
                                      confidence=c.confidence, raw=c.raw))
    return out


def test_rules_parse_problem_statement_sentence():
    evs = rules.parse(PS_SENTENCE, LEX)
    got = [(e.kind, e.item, e.party, e.qty, e.amount_rupees) for e in evs]
    assert got == [
        (Kind.purchase, "tomato", None, 3.0, 180.0),
        (Kind.credit_paid, None, "sharma", None, 40.0),
        (Kind.sale, "poha", None, 7.0, 140.0),   # priced from lexicon
    ]


def test_rules_ignore_chatter_and_learn_lexicon_drop():
    assert rules.parse("aaj bahut garmi hai bhai", LEX) == []
    lex = json.loads(json.dumps(LEX))
    assert rules.parse("2 peti kanda liya 300", lex)[0].qty is None   # unknown unit
    lex["units"]["peti"] = {"unit": "kg", "factor": 20}                # Lexicon Drop
    assert rules.parse("2 peti kanda liya 300", lex)[0].qty == 40


def test_same_sale_from_voice_and_sms_counts_once(tmp_path):
    s = EventStore(tmp_path / "a.db", "a")
    _add(s, "7 plate poha de 140", Source.voice)
    _add(s, "7 plate poha becha 140", Source.sms)
    rep = fuse(s.all())
    assert len(rep.duplicates) == 1
    assert balances(rep.effective)["cash"] == 14000
    merged = next(e for e in rep.effective if e.id.startswith("fused:"))
    assert merged.confidence > 0.75   # two independent sources -> more confident


def test_conflicting_credit_claims_go_to_suspense(tmp_path):
    a = EventStore(tmp_path / "a.db", "phone-1")
    b = EventStore(tmp_path / "b.db", "phone-2")
    _add(a, "sharma ji ka 40 jama", Source.voice)
    _add(b, "sharma ji ka 400 jama", Source.tally)
    a.ingest(b.all())
    rep = fuse(a.all())
    assert len(rep.conflicts) == 1
    bal = balances(rep.effective)
    assert bal["cash"] == 4000              # only the undisputed 40 counted as cash
    assert bal["suspense"] == 36000         # 360 parked until resolved
    assert trial_balance_ok(rep.effective)


def test_recipe_recovers_grams_per_plate():
    plates = np.array([[50], [80], [65], [40], [90]], dtype=float)
    true = 0.08                              # 80 g poha per plate
    burn = plates * true + np.array([[0.2], [0.1], [0.3], [0.2], [0.1]])   # + some waste
    out = inference.recipe_per_plate(burn, plates)
    assert abs(out["usage_per_plate"][0][0] - true) < 0.01


def test_loss_attribution_shifts_with_covariates():
    hot = inference.attribute_loss(1.0, {"temperature_c": 40, "perishable": True})
    away = inference.attribute_loss(1.0, {"unattended_hours": 6})
    assert hot["split"]["spoilage"]["p"] > away["split"]["spoilage"]["p"]
    assert away["split"]["theft"]["p"] > hot["split"]["theft"]["p"]
    assert hot["reasons"]


def test_profit_is_a_range(tmp_path):
    s = EventStore(tmp_path / "a.db", "a")
    _add(s, PS_SENTENCE, Source.voice)
    _add(s, "pandey ji ka 60 udhaar", Source.voice)
    p = inference.profit_range(fuse(s.all()).effective)
    assert p["p10"] <= p["p50"] <= p["p90"]
    assert p["receivables"]["pandey"] == 60.0
