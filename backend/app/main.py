"""HTTP API for the local UI and for peer-to-peer sync. Runs entirely on localhost / LAN."""
from functools import lru_cache

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.config import settings
from app.ledger import inference
from app.ledger.doubleentry import balances, postings_for, trial_balance_ok
from app.ledger.events import CandidateEvent, Event, Source
from app.ledger.fusion import fuse
from app.ledger.store import EventStore, causal_order
from app.perception import rules
from app.perception.lexicon import Lexicon
from app.sync.transport import LanTransport

app = FastAPI(title="Invisible Worker", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

store = EventStore(settings.resolve(settings.db_path), settings.device_id)
lexicon = Lexicon(settings.resolve(settings.lexicon_path))


# Heavy models load on first use so the API (and sync) work even if a model is missing.
@lru_cache
def extractor():
    from app.perception.extractor import Extractor
    return Extractor(settings.ollama_host, settings.llm_model, lexicon)


@lru_cache
def slip_reader():
    from app.perception.vision import SlipReader
    return SlipReader(settings.ollama_host, settings.llm_model)


# --- health ------------------------------------------------------------------
@app.get("/health")
def health():
    try:
        tags = httpx.get(f"{settings.ollama_host}/api/tags", timeout=2).json()
        ollama = [m["name"] for m in tags.get("models", [])]
    except httpx.HTTPError:
        ollama = None
    return {"device_id": settings.device_id, "ollama_models": ollama, "events": len(store.all())}


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


def _record(cands: list[CandidateEvent]) -> list[dict]:
    created = []
    for c in cands:
        ev = store.append_local(
            kind=c.kind, source=c.source, postings=postings_for(c),
            payload=c.model_dump(exclude={"kind", "source", "raw", "confidence"}),
            confidence=c.confidence, raw=c.raw,
        )
        created.append(ev.model_dump(mode="json"))
    return created


@app.post("/ingest/text")
def ingest_text(body: TextIn):
    """Typed text, SMS, or a transcript -> candidate events -> ledger.

    auto: try the local LLM, fall back to the rule parser if the model isn't available.
    """
    if body.engine in ("auto", "llm"):
        try:
            ex = extractor().from_text(body.text, body.source)
            return {"engine": "llm", "is_transaction": ex.is_transaction, "events": _record(ex.events)}
        except Exception as e:  # model not downloaded / Ollama not running
            if body.engine == "llm":
                raise HTTPException(503, f"extractor unavailable: {e}") from e
    lexicon.reload_if_changed()
    cands = rules.parse(body.text, lexicon.data, body.source)
    return {"engine": "rules", "is_transaction": bool(cands), "events": _record(cands)}


@app.post("/ingest/slip")
async def ingest_slip(file: UploadFile = File(...)):
    """Photo of a wholesale slip -> lines for the vendor to confirm (not posted yet)."""
    try:
        slip = slip_reader().read(await file.read())
    except Exception as e:
        raise HTTPException(503, f"slip reader unavailable: {e}") from e
    return slip.model_dump()


# --- lexicon (Lexicon Drop) --------------------------------------------------
class LexiconEntry(BaseModel):
    section: str          # items | units | aliases | verbs
    key: str
    value: str | dict


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
