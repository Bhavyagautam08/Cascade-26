"""Run every real sample in eval/samples through the RUNNING backend (real models, real HTTP path) and
score it against its human answer key. Writes eval/reports/<timestamp>.md and .json.

    cd backend
    uv run python ../eval/run_eval.py                    # backend at http://127.0.0.1:8000
    uv run python ../eval/run_eval.py --only slips       # slips | audio | text
    uv run python ../eval/run_eval.py --url http://127.0.0.1:8001

Start the backend with a throwaway database so eval entries never land in a real ledger:
    $env:DB_PATH="$env:TEMP\\iw-eval.db"; uv run uvicorn app.main:app --port 8000

Refuses to run against MODEL_MODE=demo: a stand-in can't be evaluated. Every report records which
model answered each sample, and a freshly randomised text case guards against canned answers.
"""
import argparse
import datetime as dt
import difflib
import json
import random
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent
SAMPLES = ROOT / "samples"
TO_BASE = {"kg": ("kg", 1), "g": ("kg", 0.001), "gm": ("kg", 0.001), "l": ("l", 1), "ml": ("l", 0.001)}
FLAG_BELOW = 0.6   # the UI highlights slip lines under this confidence


def base(qty, unit):
    if qty is None or unit is None:
        return qty, unit
    u, f = TO_BASE.get(unit.lower(), (unit.lower(), 1))
    return round(qty * f, 6), u


def same(a, b, tol=1e-6):
    return (a is None and b is None) or (a is not None and b is not None and abs(float(a) - float(b)) <= tol)


def match(expected: list[dict], got: list[dict], key="item"):
    """Pair expected and produced rows by closest name. Returns [(exp, got_or_None)]."""
    pool = list(got)
    pairs = []
    for e in expected:
        names = [str(g.get(key) or "") for g in pool]
        best = difflib.get_close_matches(str(e.get(key) or ""), names, n=1, cutoff=0.6)
        g = pool.pop(names.index(best[0])) if best else None
        pairs.append((e, g))
    return pairs, pool


# --- slips -------------------------------------------------------------------------------------
def eval_slip(client, img: Path):
    key = json.loads(img.with_name(img.stem + ".expected.json").read_text(encoding="utf-8"))
    t = time.time()
    r = client.post("/ingest/slip", files={"file": (img.name, img.read_bytes(), "image/jpeg")}, timeout=300)
    secs = time.time() - t
    if r.status_code != 200:
        return {"sample": img.name, "error": f"HTTP {r.status_code}: {r.text[:300]}", "secs": secs}
    out = r.json()
    pairs, extra = match(key["lines"], out["lines"])
    rows, s = [], {"lines": len(key["lines"]), "found": 0, "qty_ok": 0, "amount_ok": 0, "wrong_unflagged": 0}
    for e, g in pairs:
        eq = base(e.get("qty"), e.get("unit"))
        row = {"expected": f"{e['item']} {e.get('qty')}{e.get('unit') or ''}" + (f" Rs{e['amount_rupees']}" if e.get("amount_rupees") is not None else "")}
        if g is None:
            row.update(got="(missing)", ok=False)
        else:
            s["found"] += 1
            gq = base(g.get("qty"), g.get("unit"))
            q_ok = same(eq[0], gq[0]) and (eq[1] == gq[1] or eq[0] is None)
            a_ok = same(e.get("amount_rupees"), g.get("amount_rupees"), 0.5)
            s["qty_ok"] += q_ok
            s["amount_ok"] += a_ok
            flagged = g.get("confidence", 1) < FLAG_BELOW
            if not (q_ok and a_ok) and not flagged:
                s["wrong_unflagged"] += 1
            row.update(got=f"{g['item']} {g.get('qty')}{g.get('unit') or ''}" + (f" Rs{g['amount_rupees']}" if g.get("amount_rupees") is not None else ""),
                       conf=g.get("confidence"), read_as=g.get("text"), ok=q_ok and a_ok)
        rows.append(row)
    s["extra_lines"] = len(extra)
    s["supplier_ok"] = (key.get("supplier") or "").lower() == (out.get("supplier") or "").lower()
    s["total_ok"] = same(key.get("total_rupees"), out.get("total_rupees"), 0.5)
    return {"sample": img.name, "verified": key.get("verified_by") is not None, "reader": out.get("reader"),
            "rotation": out.get("rotation"), "secs": round(secs, 1), "score": s, "rows": rows,
            "extra": [x.get("text") or x.get("item") for x in extra]}


# --- text / audio events ----------------------------------------------------------------------------
def _event_ok(e: dict, g: dict) -> bool:
    """Every field the answer key states must match; fields it leaves out are not checked."""
    if e["kind"] != g["kind"]:
        return False
    if "party" in e and str(e["party"]).lower() != str(g.get("party")).lower():
        return False
    if "amount_rupees" in e and not same(e["amount_rupees"], g.get("amount_rupees"), 0.5):
        return False
    if "qty" in e and not same(base(e["qty"], e.get("unit"))[0], base(g.get("qty"), g.get("unit"))[0]):
        return False
    return True


def score_events(expected: list[dict], got: list[dict]):
    flat = [{"kind": g["kind"], **{k: g["payload"].get(k) for k in ("item", "qty", "unit", "amount_rupees", "party")}}
            for g in got if g["kind"] != "adjustment" or g["payload"].get("amount_rupees")]
    exp = [{**e, "_k": f"{e['kind']}:{e.get('item') or e.get('party') or ''}"} for e in expected]
    for f in flat:
        f["_k"] = f"{f['kind']}:{f.get('item') or f.get('party') or ''}"
    pairs, extra = match(exp, flat, key="_k")
    ok = 0
    detail = []
    for e, g in pairs:
        good = g is not None and _event_ok(e, g)
        ok += good
        detail.append({"expected": e["_k"] + (f" Rs{e['amount_rupees']}" if 'amount_rupees' in e else ""),
                       "got": (g["_k"] + f" qty={g.get('qty')}{g.get('unit') or ''} Rs{g.get('amount_rupees')}") if g else "(missing)", "ok": good})
    return {"events": len(expected), "correct": ok, "extra": len(extra), "exact": ok == len(expected) and not extra}, detail


def eval_text(client, case: dict):
    t = time.time()
    r = client.post("/ingest/text", json={"text": case["text"], "source": "manual", "engine": "auto"}, timeout=300)
    if r.status_code != 200:
        return {"sample": case["id"], "error": f"HTTP {r.status_code}: {r.text[:300]}"}
    out = r.json()
    s, detail = score_events(case["events"], out["events"])
    return {"sample": case["id"], "text": case["text"], "engine": out["engine"], "fallback": out.get("fallback_reason"),
            "secs": round(time.time() - t, 1), "score": s, "rows": detail}


def random_case():
    """Changes every run: a system with canned answers can't pass it."""
    item, word = random.choice([("onion", "pyaz"), ("potato", "aloo"), ("tomato", "tamatar")])
    q, price = random.randint(2, 9), random.randint(3, 60) * 10
    return {"id": "random", "text": f"{q} kilo {word} liya {price} mein",
            "events": [{"kind": "purchase", "item": item, "qty": q, "unit": "kg", "amount_rupees": price}]}


def eval_audio(client, wav: Path):
    key_path = wav.with_name(wav.stem + ".expected.json")
    key = json.loads(key_path.read_text(encoding="utf-8")) if key_path.exists() else None
    t = time.time()
    r = client.post("/ingest/audio", files={"file": (wav.name, wav.read_bytes(), "audio/wav")}, timeout=300)
    if r.status_code != 200:
        return {"sample": wav.name, "error": f"HTTP {r.status_code}: {r.text[:300]}"}
    out = r.json()
    res = {"sample": wav.name, "asr": out.get("asr"), "engine": out.get("engine"), "secs": round(time.time() - t, 1),
           "heard": out.get("transcript"), "heard_conf": out.get("confidence"),
           "events": [f"{e['kind']} {e['payload'].get('item') or e['payload'].get('party') or ''} "
                      f"{e['payload'].get('qty')}{e['payload'].get('unit') or ''} Rs{e['payload'].get('amount_rupees')}"
                      for e in out.get("events", [])]}
    if key:
        ref, hyp = key["transcript"].lower().split(), (out.get("transcript") or "").lower().split()
        sm = difflib.SequenceMatcher(a=ref, b=hyp)
        res["word_accuracy"] = round(sum(b.size for b in sm.get_matching_blocks()) / max(len(ref), 1), 2)
        res["score"], res["rows"] = score_events(key["events"], out.get("events", []))
    else:
        res["note"] = "no answer key yet: output shown, not scored"
    return res


# --- report ------------------------------------------------------------------------------------------
def write_report(health: dict, results: dict) -> Path:
    stamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    out = ROOT / "reports" / stamp
    out.with_suffix(".json").write_text(json.dumps({"health": health, **results}, indent=2, ensure_ascii=False), encoding="utf-8")
    L = [f"# Eval {stamp}", "", f"LLM `{health.get('llm_model')}` · ASR `{(health.get('asr') or {}).get('loaded')}` · "
         f"mode `{health.get('model_mode')}`", ""]
    if results.get("slips"):
        tot = {k: sum(r.get("score", {}).get(k, 0) for r in results["slips"]) for k in ("lines", "found", "qty_ok", "amount_ok", "wrong_unflagged")}
        L += ["## Slips", "", f"**Quantities right: {tot['qty_ok']}/{tot['lines']}** · lines found {tot['found']}/{tot['lines']} · "
              f"**wrong but NOT flagged for the vendor: {tot['wrong_unflagged']}**", ""]
        for r in results["slips"]:
            if "error" in r:
                L += [f"### {r['sample']}  ERROR", r["error"], ""]
                continue
            L += [f"### {r['sample']}  ({r['secs']}s, rotated {r['rotation']}°, key {'verified' if r['verified'] else 'DRAFT'})", "",
                  "| expected | got | conf | read as | ok |", "|---|---|---|---|---|"]
            L += [f"| {x['expected']} | {x['got']} | {x.get('conf', '')} | {x.get('read_as') or ''} | {'✅' if x['ok'] else '❌'} |" for x in r["rows"]]
            L += [f"\nsupplier ok: {r['score']['supplier_ok']} · total ok: {r['score']['total_ok']} · extra lines: {r['extra']}", ""]
    if results.get("text"):
        ok = sum(r.get("score", {}).get("exact", False) for r in results["text"])
        L += ["## Text", "", f"**Exactly right: {ok}/{len(results['text'])}**", "", "| case | engine | result | detail |", "|---|---|---|---|"]
        for r in results["text"]:
            if "error" in r:
                L.append(f"| {r['sample']} | | ERROR | {r['error']} |")
                continue
            det = "; ".join(f"{'✅' if d['ok'] else '❌'} {d['expected']} → {d['got']}" for d in r["rows"]) or "chatter (no events expected)"
            L.append(f"| {r['sample']}: {r['text'][:50]} | {r['engine']} | {'✅' if r['score']['exact'] else '❌'} {r['score']['correct']}/{r['score']['events']} (+{r['score']['extra']} extra) | {det} |")
        L.append("")
    if results.get("audio"):
        L += ["## Audio", ""]
        for r in results["audio"]:
            if "error" in r:
                L += [f"### {r['sample']}  ERROR", r["error"], ""]
                continue
            L += [f"### {r['sample']}  ({r['secs']}s, {r['asr']}, {r['engine']})", f"- heard ({r['heard_conf']}): {r['heard']}",
                  f"- entries: {r['events'] or 'none'}"]
            L += [f"- word accuracy {r['word_accuracy']} · events {r['score']['correct']}/{r['score']['events']}"] if "score" in r else [f"- {r['note']}"]
            L.append("")
    out.with_suffix(".md").write_text("\n".join(L), encoding="utf-8")
    return out.with_suffix(".md")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--only", choices=["slips", "audio", "text"])
    a = ap.parse_args()
    client = httpx.Client(base_url=a.url)
    health = client.get("/health").json()
    if health.get("model_mode") == "demo":
        raise SystemExit("backend is in MODEL_MODE=demo: stand-ins can't be evaluated")
    results: dict = {}
    if a.only in (None, "slips"):
        results["slips"] = [eval_slip(client, p) for p in sorted((SAMPLES / "slips").glob("*.jp*g")) + sorted((SAMPLES / "slips").glob("*.png"))
                            if p.with_name(p.stem + ".expected.json").exists()]
    if a.only in (None, "text"):
        cases = [json.loads(l) for l in (SAMPLES / "text" / "cases.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
        results["text"] = [eval_text(client, c) for c in cases + [random_case()]]
    if a.only in (None, "audio"):
        results["audio"] = [eval_audio(client, p) for p in sorted((SAMPLES / "audio").glob("*.wav"))]
    print(write_report(health, results).read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
