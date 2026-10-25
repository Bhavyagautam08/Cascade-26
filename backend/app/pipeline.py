"""One path from evidence to ledger, shared by the HTTP API and the always-on mic.

text --(local LLM, else rule parser)--> candidate events --> balanced postings --> event log
"""
import logging
from functools import lru_cache

import numpy as np

from app.config import settings
from app.ledger.doubleentry import postings_for
from app.ledger.events import CandidateEvent, Source
from app.ledger.store import EventStore
from app.perception import rules
from app.perception.lexicon import Lexicon

log = logging.getLogger("pipeline")

store = EventStore(settings.resolve(settings.db_path), settings.device_id)
lexicon = Lexicon(settings.resolve(settings.lexicon_path))
recent_transcripts: list[dict] = []   # last few heard utterances, for the UI (text only, no audio)


# Heavy models load on first use, so the app (and sync) run even when a model is missing.
@lru_cache
def extractor():
    from app.perception.extractor import Extractor
    return Extractor(settings.ollama_host, settings.llm_model, lexicon)


@lru_cache
def slip_reader():
    from app.perception.vision import SlipReader
    return SlipReader(settings.ollama_host, settings.llm_model)


@lru_cache
def asr():
    from app.perception.asr import ASR
    try:
        return ASR(settings.whisper_model, settings.whisper_device, settings.whisper_compute_type)
    except Exception as e:  # no GPU / CUDA libs missing -> CPU fallback model
        log.warning("GPU whisper failed (%s); falling back to %s on CPU", e, settings.whisper_fallback_model)
        return ASR(settings.whisper_fallback_model, "cpu", "int8")


def record(cands: list[CandidateEvent]) -> list[dict]:
    created = []
    for c in cands:
        ev = store.append_local(
            kind=c.kind, source=c.source, postings=postings_for(c),
            payload=c.model_dump(exclude={"kind", "source", "raw", "confidence"}),
            confidence=c.confidence, raw=c.raw,
        )
        created.append(ev.model_dump(mode="json"))
    return created


def handle_text(text: str, source: Source, engine: str = "auto") -> dict:
    """engine: auto (LLM, fall back to rules) | llm | rules"""
    if engine in ("auto", "llm"):
        try:
            ex = extractor().from_text(text, source)
            return {"engine": "llm", "is_transaction": ex.is_transaction, "events": record(ex.events)}
        except Exception as e:
            if engine == "llm":
                raise
            log.info("LLM unavailable (%s); using rule parser", e)
    lexicon.reload_if_changed()
    cands = rules.parse(text, lexicon.data, source)
    return {"engine": "rules", "is_transaction": bool(cands), "events": record(cands)}


def handle_utterance(audio: np.ndarray) -> None:
    """Called by the mic thread for every speech segment. Raw audio is dropped after this."""
    lexicon.reload_if_changed()
    t = asr().transcribe(audio, hotwords=lexicon.hotwords())
    if t is None:
        return
    result = handle_text(t.text, Source.voice)
    recent_transcripts.append({"text": t.text, "confidence": round(t.confidence, 2),
                               "language": t.language, "events": len(result["events"])})
    del recent_transcripts[:-20]
