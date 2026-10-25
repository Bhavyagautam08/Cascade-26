"""Write a SIMULATED multi-day history into an EMPTY ledger, for demos (see backend/app/seed.py).

    cd backend
    uv run python ..\\scripts\\seed_demo.py --db data\\ledger-demo.db
    # then run the app on it:  $env:DB_PATH="data\\ledger-demo.db"; uv run uvicorn app.main:app --port 8000

Refuses a ledger that already has entries. Prints what the scenario planted and what the app recovered.
"""
import argparse
import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))

from app import seed  # noqa: E402
from app.ledger.store import EventStore  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", required=True, help="ledger file to create (relative paths are under backend/)")
    ap.add_argument("--scenario", default=str(Path(__file__).with_name("demo_scenario.json")))
    a = ap.parse_args()
    sc = json.loads(Path(a.scenario).read_text(encoding="utf-8"))
    db = Path(a.db) if Path(a.db).is_absolute() else BACKEND / a.db
    try:
        report = seed.run(EventStore(db, sc["device_id"]), sc)
    except (seed.NotEmpty, seed.ScenarioError) as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1
    print(f"wrote {report['events']} entries over {report['days']} simulated days into {db}")
    print("recipe   planted -> recovered from the ledger")
    for r in report["recipe"]:
        got = "not recovered" if r["recovered"] is None else f"{r['recovered']:.4f}"
        print(f"  {r['dish']:5} {r['ingredient']:6} {r['planted']:.4f} -> {got}  {'ok' if r['ok'] else 'OFF'}")
    return 0 if report["recovered"] else 2


if __name__ == "__main__":
    sys.exit(main())
