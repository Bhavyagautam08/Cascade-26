"""Write golden files: inputs + what the PYTHON code answers, for the TypeScript port to reproduce exactly.

    cd backend
    uv run python ../scripts/make_golden.py

Writes mobile/src/core/__golden__/{rules,sms,fusion}.json. Re-run whenever the Python logic changes;
the mobile tests (cd mobile; npx jest) then show any place the port disagrees.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app.ledger import days  # noqa: E402
from app.ledger.doubleentry import balances, postings_for  # noqa: E402
from app.ledger.events import Kind, Source  # noqa: E402
from app.ledger.fusion import fuse  # noqa: E402
from app.ledger.store import EventStore  # noqa: E402
from app.perception import rules, sms  # noqa: E402

OUT = ROOT / "mobile" / "src" / "core" / "__golden__"
LEX = json.loads((ROOT / "backend" / "data" / "lexicon.json").read_text(encoding="utf-8"))
SENTENCES = [json.loads(ln)["text"] for ln in (ROOT / "eval" / "samples" / "text" / "cases.jsonl").read_text(encoding="utf-8").splitlines() if ln.strip()] + [
    "5 plate poha de do", "7 plate poha de 2 baje", "3 plate poha 60 mein becha 2 baje", "chai 10 de 20",
    "chhotu 140", "2 kilo pyaz laya 80 aur 1 kilo aloo 30", "1 kilo aloo 30", "sharma ji ko 50 diya",
    "gas ka 300 kharcha", "5 kilo tamatar bacha", "meena ji ka 90 udhaar", "sharma ji ka 40 jama",
    "sharma ji ka 400 jama", "7 plate poha de 140", "7 plate poha becha 150", "10 kilo tamatar liya 300",
    "4 kilo tamatar bacha", "pandey ji ka 60 udhaar likh", "5 cup chai de", "7 plate poha de 140 aur 5 cup chai de",
    "aadha kilo pyaz", "do sau ka tel liya", "soo gram mirchi", "ek sau assi mein tamatar liya",
    "Bhai 3 kilo tamatar liya 180 mein... Sharma ji ka 40 jama kar, aur 7 plate poha de.",
    "3 kilo tamatar liya 180 mein or sharma ji ka 60 udhar",
]
SMS = [
    "Rs.140 credited to your a/c XX1234 from CHHOTU via UPI", "Rs 140 received from Sharma via UPI",
    "INR 250.00 debited for Gupta Traders", "7 plate poha becha 140", "Rs 90 received from MEENA via UPI",
    "Rs 55 received from STRANGER via UPI", "Your a/c XX12 debited by Rs.1,250.50 to VPA gupta@upi on 26-10",
]


def cand(c):
    return c.model_dump(mode="json")


class Phone:
    """A store with a clock we set by hand, as in tests/test_twins.py."""

    def __init__(self, tmp: Path, name: str, clock: float):
        self.t = [clock]
        self.s = EventStore.open(tmp / f"{name}.db", name, wall_clock=lambda: 1_792_900_000.0, mono=lambda: self.t[0])

    def at(self, clock):
        self.t[0] = clock
        return self

    def say(self, text, source=Source.voice):
        return [self.s.append_local(c.kind, c.source, postings_for(c),
                                    payload=c.model_dump(exclude={"kind", "source", "raw", "confidence"}),
                                    confidence=c.confidence, raw=c.raw) for c in rules.parse(text, LEX, source)]

    def decide(self, key, *ids):
        return self.s.append_local(Kind.adjustment, Source.manual, [], payload={key: sorted(ids)})


def meet(p, q, sid, long=False):
    p.s.record_contact(q.s.device_id, sid, long=long)
    q.s.record_contact(p.s.device_id, sid, long=long)


def sync(*phones):
    for p in phones:
        for q in phones:
            if p is not q:
                p.s.ingest(q.s.all())


def scenarios(tmp: Path):
    def fresh(name):
        d = tmp / name
        d.mkdir()
        return d

    d = fresh("twin")
    a, b = Phone(d, "phone-1", 100.0), Phone(d, "phone-2", 5000.0)
    meet(a, b, "s1")
    a.at(103.0).say("7 plate poha de 140")
    b.at(5004.5).say("7 plate poha de 140")
    sync(a, b)
    yield "one sale heard by two phones", a

    d = fresh("dispute")
    a, b = Phone(d, "phone-1", 50.0), Phone(d, "phone-2", 900.0)
    meet(a, b, "s1")
    a.at(52.0).say("7 plate poha de 140")
    b.at(903.0).say("7 plate poha de 150")
    sync(a, b)
    yield "one utterance two amounts", a

    d = fresh("udhaar")
    a, b = Phone(d, "phone-1", 0.0), Phone(d, "phone-2", 0.0)
    meet(a, b, "s1")
    a.at(1.0).say("sharma ji ka 40 jama")
    b.at(2.0).say("sharma ji ka 60 jama")
    sync(a, b)
    yield "udhaar two amounts", a

    d = fresh("misheard")
    a, b = Phone(d, "phone-1", 0.0), Phone(d, "phone-2", 0.0)
    a.at(1.0).say("sharma ji ka 40 jama")
    b.at(2.0).say("sharma ji ka 400 jama", Source.tally)
    sync(a, b)
    yield "out of touch 40 vs 400", a

    d = fresh("possible")
    a, b = Phone(d, "phone-1", 0.0), Phone(d, "phone-2", 0.0)
    x = a.at(5.0).say("7 plate poha de 140")[0]
    y = b.at(6.0).say("7 plate poha de 140")[0]
    sync(a, b)
    yield "out of touch identical", a
    a.decide("same", x.id, y.id)
    sync(a, b)
    yield "out of touch identical, then same", a
    b.decide("separate", x.id, y.id)
    sync(a, b)
    yield "out of touch identical, then separate", a

    d = fresh("pairs")
    a, b = Phone(d, "phone-1", 0.0), Phone(d, "phone-2", 0.0)
    meet(a, b, "s1")
    a.at(1.0).say("7 plate poha de 140")
    b.at(2.0).say("7 plate poha de 140")
    a.at(25.0).say("7 plate poha de 140")
    b.at(26.5).say("7 plate poha de 140")
    sync(a, b)
    yield "two identical sales heard by both", a

    d = fresh("items")
    a, b = Phone(d, "phone-1", 0.0), Phone(d, "phone-2", 0.0)
    meet(a, b, "s1")
    a.at(1.0).say("7 plate poha de 140 aur 5 cup chai de")
    b.at(1.5).say("5 cup chai de aur 7 plate poha de 140")
    sync(a, b)
    yield "one order two items", a

    d = fresh("sms")
    a, b = Phone(d, "phone-1", 0.0), Phone(d, "phone-2", 0.0)
    meet(a, b, "s1", long=True)
    a.at(10.0).say("sharma ji ka 40 jama")
    sync(a, b)
    b.at(160.0).say("sharma ji ka 40 jama", Source.sms)
    sync(a, b)
    yield "voice then sms on two phones", a

    d = fresh("echo")
    a = Phone(d, "phone-1", 0.0)
    a.at(1.0).say("7 plate poha de 140")
    a.at(3.0).say("7 plate poha de 140")
    a.at(200.0).say("7 plate poha de 140")
    a.at(201.0).say("7 plate poha becha 140", Source.sms)
    yield "echo, quiet stall, cross-modal", a

    d = fresh("days")
    a, b = Phone(d, "phone-1", 0.0), Phone(d, "phone-2", 0.0)
    a.at(1.0).say("10 kilo tamatar liya 300")
    days.start_day(a.s)
    a.at(2.0).say("4 kilo tamatar bacha")
    sync(a, b)
    days.start_day(b.s)
    b.at(3.0).say("gas ka 300 kharcha")
    sync(a, b)
    yield "days", a


def main():
    import tempfile
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "rules.json").write_text(json.dumps(
        {"lexicon": LEX, "cases": [{"text": t, "spoken": rules.spoken_numbers(t, LEX), "events": [cand(c) for c in rules.parse(t, LEX)],
                                    "unparsed": rules.parse_detailed(t, LEX).unparsed} for t in SENTENCES]},
        ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "sms.json").write_text(json.dumps(
        [{"text": t, "txn": (lambda r: r and {"direction": r.direction, "amount_rupees": r.amount_rupees, "party": r.party})(sms.parse(t))}
         for t in SMS], ensure_ascii=False, indent=1), encoding="utf-8")
    out = []
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:   # Windows: SQLite still holds the files
        for name, phone in scenarios(Path(tmp)):
            evs = phone.s.all()
            rep = fuse(evs)
            out.append({"name": name, "events": [e.model_dump(mode="json") for e in evs],
                        "effective": [{"id": e.id, "postings": [p.model_dump() for p in e.postings], "confidence": e.confidence}
                                      for e in rep.effective],
                        "duplicates": rep.duplicates, "conflicts": rep.conflicts,
                        "possible_conflicts": rep.possible_conflicts, "possible_duplicates": rep.possible_duplicates,
                        "balances": balances(rep.effective), "days": days.list_days(evs)})
    (OUT / "fusion.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    # inference: the seeded 5-day demo ledger (scripts/demo_scenario.json) + a plain recipe fit
    from app import seed
    from app.ledger import inference
    sc = json.loads((ROOT / "scripts" / "demo_scenario.json").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        store = EventStore.open(Path(tmp) / "demo.db", sc["device_id"])
        seed.run(store, sc)
        evs = store.all()
        eff = fuse(evs).effective
        n_days = days.current_day(evs)
        inf = {
            "events": [e.model_dump(mode="json") for e in evs],
            "perishable": LEX.get("perishable", []),
            "receivables": inference.receivables(eff),
            "day_profit": {str(i): inference.day_profit(eff, i) for i in range(1, n_days + 1)},
            "wastage": inference.wastage_from_ledger(eff, LEX.get("perishable", [])),
            "recipe": {"burn": [[3.3, 1.0], [5.1, 1.4], [6.9, 2.2], [4.0, 1.1]], "plates": [[40, 60], [62, 90], [85, 130], [50, 70]]},
            "loss": [{"kg": 1.2, "cov": c, "out": inference.attribute_loss(1.2, c)}
                     for c in ({}, {"temperature_c": 38, "perishable": True}, {"unattended_hours": 3, "family_present": 2})],
        }
        inf["recipe"]["out"] = inference.recipe_per_plate(inf["recipe"]["burn"], inf["recipe"]["plates"])
    (OUT / "inference.json").write_text(json.dumps(inf, ensure_ascii=False, indent=1), encoding="utf-8")

    # the exact system prompt the laptop sends the model (extractor.py), for the app to reproduce byte for byte
    from app.perception import extractor
    (OUT / "prompts.json").write_text(json.dumps({
        "lexicon": LEX, "extract_system": extractor.SYSTEM.format(lexicon=json.dumps(LEX, ensure_ascii=False)),
        "extract_schema": extractor.LLMOutput.model_json_schema(),
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {len(SENTENCES)} rule cases, {len(SMS)} sms cases, {len(out)} fusion scenarios, "
          f"inference over {len(inf['events'])} demo entries / {n_days} days to {OUT}")


if __name__ == "__main__":
    main()
