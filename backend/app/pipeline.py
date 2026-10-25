"""One path from evidence to ledger, shared by the HTTP API and the always-on mic.

text --(local LLM, else rule parser)--> candidate events --> balanced postings --> event log

MODEL_MODE=demo swaps the three models for the stand-ins in perception/demo.py; everything
downstream (ledger, fusion, inference, sync) is identical in both modes.
"""
import logging
from collections import deque
from functools import lru_cache

import numpy as np

from app.config import settings
from app.ledger.doubleentry import postings_for
from app.ledger.events import CandidateEvent, Event, Kind, Source
from app.ledger.fusion import fuse
from app.ledger.store import EventStore
from app.perception import rules
from app.perception.lexicon import Lexicon
from app.sync.clock import wall_clock

log = logging.getLogger("pipeline")

store = EventStore(settings.resolve(settings.db_path), settings.device_id, wall_clock(settings.hostile_clock))
lexicon = Lexicon(settings.resolve(settings.lexicon_path))
recent_transcripts: deque[dict] = deque(maxlen=20)   # last few heard utterances, text only, no audio


# Heavy models load on first use, so the app (and sync) run even when a model is missing.
@lru_cache
def extractor():
    if settings.demo:
        from app.perception.demo import DemoExtractor
        return DemoExtractor(lexicon)
    from app.perception.extractor import Extractor
    return Extractor(settings.ollama_host, settings.llm_model, lexicon)


@lru_cache
def slip_reader():
    if settings.demo:
        from app.perception.demo import DemoSlipReader
        return DemoSlipReader()
    from app.perception.vision import SlipReader
    return SlipReader(settings.ollama_host, settings.llm_model)


@lru_cache
def asr():
    if settings.demo:
        from app.perception.demo import DemoASR
        return DemoASR(settings.resolve("data/demo_utterances.txt"))
    from app.perception.asr import ASR
    try:
        return ASR(settings.whisper_model, settings.whisper_device, settings.whisper_compute_type)
    except Exception as e:  # no GPU / CUDA libs missing -> CPU fallback model
        log.warning("GPU whisper failed (%s); falling back to %s on CPU", e, settings.whisper_fallback_model)
        return ASR(settings.whisper_fallback_model, "cpu", "int8")


def record(cands: list[CandidateEvent], supersedes: list[str] | None = None) -> list[dict]:
    created = []
    for c in cands:
        ev = store.append_local(
            kind=c.kind, source=c.source, postings=postings_for(c),
            payload=c.model_dump(exclude={"kind", "source", "raw", "confidence"}),
            confidence=c.confidence, raw=c.raw, supersedes=supersedes,
        )
        created.append(ev.model_dump(mode="json"))
    return created


def handle_text(text: str, source: Source, engine: str = "auto", heard_confidence: float = 1.0) -> dict:
    """engine: auto (LLM, fall back to rules) | llm | rules

    heard_confidence scales every event's confidence when the text itself is uncertain (ASR output).
    """
    cands: list[CandidateEvent] | None = None
    used = "rules"
    if engine in ("auto", "llm"):
        try:
            ex = extractor()
            cands, used = ex.from_text(text, source).events, ex.name
        except Exception as e:
            if engine == "llm":
                raise
            log.info("LLM unavailable (%s); using rule parser", e)
    if cands is None:
        lexicon.reload_if_changed()
        cands = rules.parse(text, lexicon.data, source)
    for c in cands:
        c.confidence = round(c.confidence * heard_confidence, 3)
    return {"engine": used, "is_transaction": bool(cands), "events": record(cands)}


def heard(text: str, confidence: float, language: str, via: str) -> dict:
    """A transcript from any voice path (live mic, uploaded clip, simulated) -> ledger + transcript feed."""
    result = handle_text(text, Source.voice, heard_confidence=confidence)
    recent_transcripts.append({"text": text, "confidence": round(confidence, 2), "language": language,
                               "via": via, "engine": result["engine"], "events": len(result["events"])})
    return result


def handle_utterance(audio: np.ndarray) -> None:
    """Called by the mic thread for every speech segment. Raw audio is dropped after this."""
    try:
        lexicon.reload_if_changed()
        t = asr().transcribe(audio, hotwords=lexicon.hotwords())
        if t is not None:
            heard(t.text, t.confidence, t.language, via="mic")
    except Exception:  # never let one bad utterance kill the always-on listener
        log.exception("utterance dropped")


def handle_audio_file(data: bytes) -> dict:
    """A pre-recorded clip (backup demo, bake-off) through the same ASR as the live mic."""
    lexicon.reload_if_changed()
    t = asr().transcribe_file(data, hotwords=lexicon.hotwords())
    if t is None:
        return {"transcript": None, "events": []}
    return {"transcript": t.text, "confidence": round(t.confidence, 2), "asr": asr().name,
            **heard(t.text, t.confidence, t.language, via="clip")}


# --- human decisions: stored as new events that supersede old ones ---------------------------
def resolve_conflict(ids: list[str], amount_rupees: float) -> dict:
    """Settle a suspense item: one vendor-confirmed event replaces the disputed claims."""
    conflict = next((c for c in fuse(store.all()).conflicts if sorted(c["ids"]) == sorted(ids)), None)
    if conflict is None:
        raise KeyError("no open conflict with these ids")
    by_id = {e.id: e for e in store.all()}
    first: Event = by_id[conflict["ids"][0]]
    cand = CandidateEvent(kind=first.kind, source=Source.manual, confidence=1.0,
                          party=conflict["party"], amount_rupees=amount_rupees,
                          raw="settled dispute: Rs{:g} vs Rs{:g} -> Rs{:g}".format(
                              *(c / 100 for c in conflict["claims_paise"]), amount_rupees))
    return {"events": record([cand], supersedes=sorted(ids))}


def void(event_id: str) -> dict:
    """Withdraw a wrong entry (misheard, typo). The original stays in the log, it just stops counting."""
    if event_id not in {e.id for e in store.all()}:
        raise KeyError(event_id)
    ev = store.append_local(kind=Kind.adjustment, source=Source.manual, postings=[],
                            payload={"voided": event_id}, raw=f"void {event_id}", supersedes=[event_id])
    return {"events": [ev.model_dump(mode="json")]}
