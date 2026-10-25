"""HTTP API for the local UI and for peer-to-peer sync. Runs entirely on localhost / LAN."""
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.config import settings
from app.ledger import inference
from app.ledger.doubleentry import balances, trial_balance_ok
from app.ledger.events import CandidateEvent, Event, Kind, Source
from app.ledger.fusion import fuse
from app.ledger.store import causal_order
from app.pipeline import handle_text, handle_utterance, lexicon, recent_transcripts, record, slip_reader, store
from app.sync.transport import LanTransport

mic = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global mic
    if settings.mic_enabled:
        from app.perception.mic import MicListener
        mic = MicListener(handle_utterance, settings.mic_device_index)
        mic.start()
    yield
    if mic:
        mic.stop()


app = FastAPI(title="Invisible Worker", version="0.2.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# --- health ------------------------------------------------------------------
@app.get("/health")
def health():
    try:
        tags = httpx.get(f"{settings.ollama_host}/api/tags", timeout=2).json()
        ollama = [m["name"] for m in tags.get("models", [])]
    except httpx.HTTPError:
        ollama = None
    return {
        "device_id": settings.device_id,
        "ollama_models": ollama,
        "llm_ready": bool(ollama) and settings.llm_model in ollama,
        "mic_listening": mic is not None,
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
    report = fuse(store.all())
    return {
        "balanced": trial_balance_ok(report.effective),
        "balances_paise": balances(report.effective),
        "profit": inference.profit_range(report.effective),
        "duplicates": report.duplicates,
        "conflicts": report.conflicts,
    }


# --- inference ---------------------------------------------------------------
class RecipeIn(BaseModel):
    burn: list[list[float]]       # days x ingredients
    plates: list[list[float]]     # days x dishes


class LossIn(BaseModel):
    unexplained_kg: float
    covariates: dict = {}


@app.post("/inference/recipe")
def infer_recipe(body: RecipeIn):
    return inference.recipe_per_plate(body.burn, body.plates)


@app.post("/inference/loss")
def infer_loss(body: LossIn):
    return inference.attribute_loss(body.unexplained_kg, body.covariates)


# --- ingestion ---------------------------------------------------------------
class TextIn(BaseModel):
    text: str
    source: Source = Source.manual
    engine: str = "auto"          # auto | llm | rules


@app.post("/ingest/text")
def ingest_text(body: TextIn):
    """Typed text, SMS, tally, or a transcript -> candidate events -> ledger."""
    try:
        return handle_text(body.text, body.source, body.engine)
    except Exception as e:
        raise HTTPException(503, f"extractor unavailable: {e}") from e


@app.get("/mic/recent")
def mic_recent():
    return recent_transcripts


@app.post("/ingest/slip")
async def ingest_slip(file: UploadFile = File(...)):
    """Photo of a wholesale slip -> lines for the vendor to confirm (not posted yet)."""
    try:
        slip = slip_reader().read(await file.read())
    except Exception as e:
        raise HTTPException(503, f"slip reader unavailable: {e}") from e
    return slip.model_dump()


class SlipConfirm(BaseModel):
    supplier: str | None = None
    lines: list[dict]             # [{item, qty, unit, amount_rupees, confidence}] after vendor edits


@app.post("/ingest/slip/confirm")
def confirm_slip(body: SlipConfirm):
    """Post confirmed slip lines as purchases. Vendor-confirmed lines get full confidence."""
    cands = [
        CandidateEvent(kind=Kind.purchase, source=Source.slip, confidence=float(l.get("confidence", 1.0)),
                       item=l.get("item"), qty=l.get("qty"), unit=l.get("unit"),
                       amount_rupees=l.get("amount_rupees"), party=body.supplier, raw=str(l))
        for l in body.lines
    ]
    return {"events": record(cands)}


# --- lexicon (Lexicon Drop) --------------------------------------------------
class LexiconEntry(BaseModel):
    section: str          # items | units | aliases | verbs | numbers | prices
    key: str
    value: str | float | dict


@app.get("/lexicon")
def get_lexicon():
    lexicon.reload_if_changed()
    return lexicon.data


@app.post("/lexicon")
def add_lexicon(entry: LexiconEntry):
    lexicon.add(entry.section, entry.key, entry.value)
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
    return {"added": store.ingest(body.events)}


@app.post("/sync/now")
def sync_now():
    """Exchange events with every configured peer (simulates a brief Bluetooth reconnect)."""
    results = {}
    for url in settings.peer_urls:
        try:
            results[url] = {"added": LanTransport(url).exchange(store)}
        except httpx.HTTPError as e:
            results[url] = {"error": str(e)}
    return results
