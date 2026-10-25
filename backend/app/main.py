"""HTTP API for the local UI and for peer-to-peer sync. Runs entirely on localhost / LAN.

Access:
- /sync/* (except /sync/now) is for the family's other devices and needs X-Sync-Key when SYNC_KEY is set.
- Everything else is for this laptop's UI and answers loopback callers only, unless ALLOW_REMOTE_UI=true.
  (The Vite dev server proxies the UI's calls, so they arrive from localhost.)

Errors: 503 = a model is unavailable, 502 = a model answered outside its schema, 422 = bad input,
500 = a bug in this code (never relabelled as "model unavailable").
"""
import hmac
from contextlib import asynccontextmanager
from typing import Literal

import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.config import settings
from app.ledger import inference
from app.ledger.doubleentry import balances, incomplete, trial_balance_ok
from app.ledger.events import CandidateEvent, Event, Kind, Source
from app.ledger.fusion import fuse
from app.ledger.store import causal_order
from app.perception.asr import UnsupportedAudio
from app.perception.vision import normalize as normalize_slip
from app.pipeline import (
    ModelOutputInvalid, ModelUnavailable, asr_status, ollama_problem, correct, handle_audio_file, handle_text,
    handle_utterance, heard, lexicon, recent_transcripts, record, resolve_conflict, separate, slip_reader,
    start_preload, store, void)
from app.sync.transport import SYNC_KEY_HEADER, LanTransport

mic = None
LOOPBACK = {"127.0.0.1", "::1", "localhost"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    global mic
    if not settings.demo and settings.whisper_preload:
        start_preload()
    if settings.mic_enabled:
        from app.perception.mic import MicListener
        mic = MicListener(handle_utterance, settings.mic_device_index, settings.mic_min_threshold)
        mic.start()
    yield
    if mic:
        mic.stop()


app = FastAPI(title="Invisible Worker", version="0.3.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
                   allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def access_control(request: Request, call_next):
    path = request.url.path
    if path.startswith("/sync/") and path != "/sync/now":
        if settings.sync_key and not hmac.compare_digest(request.headers.get(SYNC_KEY_HEADER, ""), settings.sync_key):
            return JSONResponse({"detail": "sync key missing or wrong"}, status_code=401)
    elif not settings.allow_remote_ui and (request.client is None or request.client.host not in LOOPBACK):
        return JSONResponse({"detail": "UI endpoints answer this laptop only (set ALLOW_REMOTE_UI=true)"},
                            status_code=403)
    return await call_next(request)


@app.exception_handler(ModelUnavailable)
async def _unavailable(_: Request, e: ModelUnavailable):
    return JSONResponse({"detail": str(e)}, status_code=503)


@app.exception_handler(ModelOutputInvalid)
async def _invalid(_: Request, e: ModelOutputInvalid):
    return JSONResponse({"detail": str(e)}, status_code=502)


@app.exception_handler(UnsupportedAudio)
async def _bad_input(_: Request, e: UnsupportedAudio):
    return JSONResponse({"detail": str(e)}, status_code=422)


# --- health ------------------------------------------------------------------
@app.get("/health")
def health():
    ollama, ollama_error = None, None
    try:
        r = httpx.get(f"{settings.ollama_host}/api/tags", timeout=2)
        r.raise_for_status()
        ollama = [m["name"] for m in r.json().get("models", [])]
    except (httpx.HTTPError, ValueError, KeyError) as e:
        ollama_error = f"{type(e).__name__}: {e}"
    try:
        whisper_ref = settings.whisper_ref(settings.whisper_model)
    except FileNotFoundError as e:
        whisper_ref = f"missing: {e}"
    return {
        "device_id": settings.device_id,
        "model_mode": "demo" if settings.demo else "real",
        "llm_model": settings.llm_model,
        "whisper_model": settings.whisper_model,
        "whisper_source": whisper_ref,          # a folder, a name resolved in the user's HF cache, or what is missing
        "asr": dict(asr_status),               # what actually loaded; source = weights folder; fallback=true means CPU
        "ollama_models": ollama,
        "ollama_error": ollama_error,
        "llm_ready": bool(ollama) and settings.llm_model in ollama,
        "llm_problem": None if settings.demo else (ollama_problem(models=ollama) if ollama is not None
                                                   else ollama_problem(httpx.ConnectError(ollama_error or ""))),
        "mic_listening": bool(mic and mic.listening),
        "mic": mic.status if mic else None,
        "hostile_clock": settings.hostile_clock,
        "peers": settings.peer_urls,
        "sync_auth": bool(settings.sync_key),
        "events": len(store.all()),
    }


# --- ledger ------------------------------------------------------------------
@app.get("/events")
def list_events():
    return [e.model_dump(mode="json") for e in causal_order(store.all())]


@app.get("/ledger/balances")
def ledger_balances():
    """Balances over the fused view: duplicates counted once, disputes parked in suspense."""
    eff = fuse(store.all()).effective
    return {"balances_paise": balances(eff), "balanced": trial_balance_ok(eff)}


@app.get("/ledger/summary")
def ledger_summary():
    events = store.all()
    report = fuse(events)
    return {
        "balanced": trial_balance_ok(report.effective),
        "balances_paise": balances(report.effective),
        "profit": inference.profit_range(report.effective),
        "duplicates": report.duplicates,
        "conflicts": report.conflicts,
        "possible_conflicts": report.possible_conflicts,
        "incomplete": incomplete(events),          # trades with no amount: not in the books at all
        "frontier": store.frontier(),
    }


class ResolveIn(BaseModel):
    ids: list[str]
    amount_rupees: float


@app.post("/ledger/resolve")
def ledger_resolve(body: ResolveIn):
    """Vendor settles a suspense item (e.g. Sharma really paid Rs40). Recorded as a superseding event."""
    try:
        return resolve_conflict(body.ids, body.amount_rupees)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e


class VoidIn(BaseModel):
    id: str


@app.post("/ledger/void")
def ledger_void(body: VoidIn):
    """Withdraw a wrong entry. Append-only: the original stays, a superseding event stops it counting."""
    try:
        return void(body.id)
    except KeyError as e:
        raise HTTPException(404, f"no event {e}") from e


class CorrectIn(BaseModel):
    id: str
    kind: Kind | None = None
    item: str | None = None
    qty: float | None = None
    unit: str | None = None
    amount_rupees: float | None = None
    party: str | None = None
    direction: Literal["in", "out"] | None = None


@app.post("/ledger/correct")
def ledger_correct(body: CorrectIn):
    """Fix or classify an entry; only the fields sent are changed."""
    try:
        return correct(body.id, body.model_dump(exclude={"id"}, exclude_unset=True))
    except KeyError as e:
        raise HTTPException(404, f"no event {e}") from e


class SeparateIn(BaseModel):
    ids: list[str]


@app.post("/ledger/separate")
def ledger_separate(body: SeparateIn):
    """Undo a merge or a dispute: these events are different trades and all of them count."""
    if len(body.ids) < 2:
        raise HTTPException(422, "need at least two ids")
    try:
        return separate(body.ids)
    except KeyError as e:
        raise HTTPException(404, f"no event {e}") from e


# --- inference ---------------------------------------------------------------
class RecipeIn(BaseModel):
    burn: list[list[float]]       # periods x ingredients
    plates: list[list[float]]     # periods x dishes


class LossIn(BaseModel):
    unexplained_kg: float
    covariates: dict = {}


@app.post("/inference/recipe")
def infer_recipe(body: RecipeIn):
    if not body.burn or len(body.burn) != len(body.plates):
        raise HTTPException(422, "burn and plates need the same, non-zero number of rows")
    return inference.recipe_per_plate(body.burn, body.plates)


@app.post("/inference/loss")
def infer_loss(body: LossIn):
    return inference.attribute_loss(body.unexplained_kg, body.covariates)


@app.get("/inference/ledger")
def infer_from_ledger():
    """Recipe, wastage and loss split computed from the ledger's own stock counts, purchases and sales."""
    lexicon.reload_if_changed()
    return inference.wastage_from_ledger(fuse(store.all()).effective, lexicon.data.get("perishable", []))


# --- ingestion ---------------------------------------------------------------
class TextIn(BaseModel):
    text: str
    source: Source = Source.manual
    engine: Literal["auto", "llm", "rules"] = "auto"


@app.post("/ingest/text")
def ingest_text(body: TextIn):
    """Typed text, SMS, tally, or a transcript -> candidate events -> ledger."""
    return handle_text(body.text, body.source, body.engine)


@app.get("/mic/recent")
def mic_recent():
    return list(recent_transcripts)


class HeardIn(BaseModel):
    text: str
    confidence: float = 0.9


@app.post("/mic/simulate")
def mic_simulate(body: HeardIn):
    """Type a line as if the mic heard it (backup demo when the hall is too loud). Recorded as typed
    (source=manual, flag simulated_voice), never as real voice evidence."""
    return heard(body.text, body.confidence, "typed", via="simulated", source=Source.manual)


@app.post("/ingest/audio")
async def ingest_audio(file: UploadFile = File(...)):
    """A recorded clip -> the same ASR + extractor path as the live mic."""
    return handle_audio_file(await file.read())


@app.post("/ingest/slip")
async def ingest_slip(file: UploadFile = File(...)):
    """Photo of a wholesale slip -> lines for the vendor to confirm (not posted yet)."""
    from app.pipeline import _model_call
    data = await file.read()
    reader = _model_call("slip reader", slip_reader)
    slip = _model_call("slip reader", lambda: reader.read(data))
    lexicon.reload_if_changed()
    return {**normalize_slip(slip, lexicon.data).model_dump(), "reader": reader.name}


class SlipConfirm(BaseModel):
    supplier: str | None = None
    lines: list[dict]             # [{item, qty, unit, amount_rupees, confidence}] after vendor edits


@app.post("/ingest/slip/confirm")
def confirm_slip(body: SlipConfirm):
    """Post confirmed slip lines. Nothing disappears:
    - a line with a price -> purchase (books money);
    - a line whose price was there but unreadable (other lines are priced, or the line was read with low
      confidence) -> purchase without postings, listed under `incomplete` for the vendor to fix;
    - a price-less list -> one order per line (pipeline.as_recorded), recorded but books nothing."""
    any_priced = any(l.get("amount_rupees") is not None for l in body.lines)

    def flags(l: dict) -> list[str]:
        if l.get("amount_rupees") is not None:
            return []
        return ["amount_unreadable"] if any_priced or float(l.get("confidence", 1.0)) < 0.6 else []

    cands = [
        CandidateEvent(kind=Kind.purchase, source=Source.slip, confidence=float(l.get("confidence", 1.0)),
                       item=l.get("item") or None, qty=l.get("qty"), unit=l.get("unit"),
                       amount_rupees=l.get("amount_rupees"), party=body.supplier, flags=flags(l), raw=str(l))
        for l in body.lines
    ]
    return {"events": record(cands)}


# --- lexicon (Lexicon Drop) --------------------------------------------------
class LexiconEntry(BaseModel):
    section: str          # items | units | aliases | verbs | numbers | prices | perishable
    key: str
    value: str | float | dict | None = None   # not needed for list sections (perishable)


@app.get("/lexicon")
def get_lexicon():
    lexicon.reload_if_changed()
    return lexicon.data


@app.post("/lexicon")
def add_lexicon(entry: LexiconEntry):
    if entry.section == "verbs" and entry.value not in {k.value for k in Kind}:
        raise HTTPException(422, f"verb must map to one of {[k.value for k in Kind]}")
    if entry.section == "units" and not (isinstance(entry.value, dict) and "factor" in entry.value and "unit" in entry.value):
        raise HTTPException(422, 'unit needs {"unit": ..., "factor": ...}')
    lexicon.add(entry.section, entry.key.lower(), entry.value)
    return lexicon.data


# --- sync --------------------------------------------------------------------
class Frontier(BaseModel):
    frontier: dict[str, int]


class EventBatch(BaseModel):
    events: list[Event]


@app.get("/sync/frontier")
def sync_frontier():
    return {"device_id": settings.device_id, "frontier": store.frontier()}


@app.post("/sync/pull")
def sync_pull(body: Frontier):
    return {"events": [e.model_dump(mode="json") for e in store.missing_for(body.frontier)]}


@app.post("/sync/push")
def sync_push(body: EventBatch):
    res = store.ingest(body.events)
    return {"added": res.added, "duplicates": res.duplicates, "rejected": res.rejected}


@app.post("/sync/now")
def sync_now():
    """Exchange events with every configured peer (simulates a brief Bluetooth reconnect).
    `added` = new events received here; `pushed` = new events the peer accepted."""
    results = {}
    for url in settings.peer_urls:
        try:
            r = LanTransport(url, settings.sync_key).exchange(store)
            results[url] = {"added": r["pulled"], **r}
        except httpx.HTTPStatusError as e:
            results[url] = {"error": f"{e.response.status_code}: {e.response.text[:200]}"}
        except httpx.HTTPError as e:
            results[url] = {"error": f"unreachable: {type(e).__name__}: {e}"}
    return results
