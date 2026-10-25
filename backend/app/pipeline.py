"""One path from evidence to ledger, shared by the HTTP API and the always-on mic.

text --(bank SMS parser | local LLM + cross-check | rule parser)--> candidate events
     --> balanced postings --> event log

MODEL_MODE=demo swaps the three models for the stand-ins in perception/demo.py; everything
downstream (ledger, fusion, inference, sync) is identical in both modes.

Failures are classified, never blurred together:
- ModelUnavailable: Ollama/Whisper not running, model missing, CUDA broken -> API 503
- ModelOutputInvalid: the model answered but not in the schema -> API 502
- anything else is a bug and surfaces as a 500; `engine=auto` only falls back to the rule parser
  for the first two, and says why in `fallback_reason`.
"""
import logging
import threading
from collections import deque
from functools import lru_cache

import httpx
import numpy as np
from pydantic import ValidationError

from app.config import settings
from app.ledger.doubleentry import balances, postings_for
from app.ledger.events import CandidateEvent, Event, Kind, Source
from app.ledger.fusion import fuse
from app.ledger.store import EventStore
from app.perception import rules, sms
from app.perception.lexicon import Lexicon
from app.sync.clock import wall_clock

log = logging.getLogger("pipeline")

store = EventStore(settings.resolve(settings.db_path), settings.device_id, wall_clock(settings.hostile_clock))
lexicon = Lexicon(settings.resolve(settings.lexicon_path))
recent_transcripts: deque[dict] = deque(maxlen=20)   # last few heard utterances, text only, no audio
asr_status: dict = {"loaded": None, "fallback": False, "error": None, "warm": False}


class ModelUnavailable(RuntimeError):
    """The model could not be reached or loaded."""


class ModelOutputInvalid(RuntimeError):
    """The model answered, but not in the required shape."""


OLLAMA_USERS = ("LLM", "slip reader")


def ollama_problem(e: Exception | None = None, models: list[str] | None = None) -> str | None:
    """Plain-language reason the language model can't be used, or None. Never fixes anything itself:
    installing Ollama and downloading the model are the user's steps (docs/SETUP.md)."""
    not_running = (f"Ollama is not running at {settings.ollama_host}: install it from https://ollama.com/download "
                   "and start it (the app keeps working with the rule parser meanwhile)")
    missing = (f"Ollama has no model '{settings.llm_model}': download it (docs/SETUP.md, "
               "https://ollama.com/library) or set LLM_MODEL in backend/.env to a model you have")
    if e is None:
        return missing if models is not None and settings.llm_model not in models else None
    msg = str(e).lower()
    if getattr(e, "status_code", None) == 404 or ("model" in msg and "not found" in msg):
        return missing
    if isinstance(e, (ConnectionError, httpx.ConnectError, httpx.ConnectTimeout)) or "failed to connect" in msg:
        return not_running
    return None


def _model_call(what: str, fn):
    try:
        return fn()
    except Exception as e:
        hint = ollama_problem(e) if what in OLLAMA_USERS else None
        if hint:
            raise ModelUnavailable(hint) from e
        return _classify(what, e)


def _classify(what: str, e: Exception):
    try:
        raise e
    except (ModelUnavailable, ModelOutputInvalid):
        raise
    except ValueError as e:
        if not isinstance(e, ValidationError):   # e.g. UnsupportedAudio: the input's fault, not the model's
            raise
        raise ModelOutputInvalid(f"{what} returned output outside the schema: {e.errors()[:1]}") from e
    except (httpx.HTTPError, ConnectionError, TimeoutError, ImportError, OSError) as e:
        raise ModelUnavailable(f"{what} unreachable: {type(e).__name__}: {e}") from e
    except Exception as e:
        if type(e).__module__.startswith(("ollama", "ctranslate2")) or "cuda" in str(e).lower() or "dll" in str(e).lower():
            raise ModelUnavailable(f"{what} failed: {type(e).__name__}: {e}") from e
        raise


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
        model = DemoASR(settings.resolve("data/demo_utterances.txt"))
    else:
        from app.perception.asr import ASR
        try:
            model = ASR(settings.whisper_ref(settings.whisper_model), settings.whisper_device,
                        settings.whisper_compute_type)
        except Exception as e:  # no GPU / CUDA libs missing -> CPU fallback model, and say so
            log.warning("GPU whisper failed (%s); falling back to %s on CPU", e, settings.whisper_fallback_model)
            asr_status.update(fallback=True, error=f"GPU model failed: {type(e).__name__}: {e}")
            model = ASR(settings.whisper_ref(settings.whisper_fallback_model), "cpu", "int8")
    asr_status["loaded"] = model.name
    return model


def preload_asr() -> None:
    """Load and warm Whisper in the background so the first real utterance isn't 20 s late."""
    try:
        _model_call("speech-to-text", lambda: asr().transcribe(np.zeros(16_000, dtype=np.float32)))
        asr_status["warm"] = True
    except Exception as e:
        asr_status["error"] = f"{type(e).__name__}: {e}"
        log.error("whisper preload failed: %s", e)


def start_preload() -> None:
    threading.Thread(target=preload_asr, daemon=True, name="asr-preload").start()


# --- recording -------------------------------------------------------------------------------
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


# --- interpretation ----------------------------------------------------------------------------
def _from_bank_sms(txn: sms.BankTxn, source: Source, text: str) -> CandidateEvent:
    """Money in from someone who owes us = repayment; everything else waits in suspense."""
    party = lexicon.data.get("aliases", {}).get(txn.party, txn.party) if txn.party else None
    owed = balances(fuse(store.all()).effective).get(f"receivable:{party}", 0) if party else 0
    if txn.direction == "in" and owed > 0:
        return CandidateEvent(kind=Kind.credit_paid, source=source, confidence=0.9, party=party,
                              amount_rupees=txn.amount_rupees, flags=["bank_sms"], raw=text)
    flag = "unclassified_inflow" if txn.direction == "in" else "unclassified_outflow"
    return CandidateEvent(kind=Kind.adjustment, source=source, confidence=0.95, party=party,
                          amount_rupees=txn.amount_rupees, direction=txn.direction, flags=["bank_sms", flag],
                          raw=text)


def cross_check(text: str, cands: list[CandidateEvent]) -> dict:
    """Hold the LLM to the words actually said: an amount that isn't in the text (and isn't qty x list
    price) is removed rather than booked; self-reported confidence is capped. Also reports whether
    the rule parser agrees, so a systematically wrong model is visible."""
    said = rules.numbers_in(text, lexicon.data.get("numbers", {}))
    prices = lexicon.data.get("prices", {})
    removed = 0
    for c in cands:
        c.confidence = min(c.confidence, settings.llm_max_confidence)
        if c.amount_rupees is None:
            continue
        priced = c.qty and c.item in prices and abs(c.qty * float(prices[c.item]) - c.amount_rupees) < 0.01
        if c.amount_rupees not in said and not priced:
            c.flags.append(f"amount_not_in_text:{c.amount_rupees:g}")
            c.amount_rupees, c.confidence = None, min(c.confidence, rules.CONF_NO_AMOUNT)
            removed += 1
        elif priced and c.amount_rupees not in said:
            c.flags.append("priced_from_list")
            c.confidence = min(c.confidence, rules.CONF_PRICED_FROM_LIST)
    by_rules = rules.parse(text, lexicon.data)
    key = lambda cs: sorted((c.kind.value, c.amount_rupees or 0) for c in cs)  # noqa: E731
    return {"rules_events": len(by_rules), "llm_events": len(cands), "agree": key(by_rules) == key(cands),
            "amounts_removed": removed}


def handle_text(text: str, source: Source, engine: str = "auto", heard_confidence: float = 1.0,
                extra_flags: list[str] | None = None) -> dict:
    """engine: auto (LLM, fall back to rules if the model is unavailable/invalid) | llm | rules

    heard_confidence scales every event's confidence when the text itself is uncertain (ASR output).
    """
    lexicon.reload_if_changed()
    result: dict = {"unparsed": [], "fallback_reason": None, "cross_check": None}
    cands: list[CandidateEvent] | None = None
    used = "rules"

    txn = sms.parse(text)
    if txn is not None:
        cands, used = [_from_bank_sms(txn, source, text)], "bank_sms"
    elif engine in ("auto", "llm"):
        try:
            ex = extractor()
            out = _model_call("LLM", lambda: ex.from_text(text, source))
            cands, used = out.events, ex.name
            if not settings.demo:
                result["cross_check"] = cross_check(text, cands)
        except (ModelUnavailable, ModelOutputInvalid) as e:
            if engine == "llm":
                raise
            result["fallback_reason"] = str(e)
            log.warning("LLM fallback to rules: %s", e)
    if cands is None:
        parsed = rules.parse_detailed(text, lexicon.data, source)
        cands, result["unparsed"] = parsed.events, parsed.unparsed

    for c in cands:
        c.confidence = round(c.confidence * heard_confidence, 3)
        c.flags.extend(extra_flags or [])
    return {"engine": used, "is_transaction": bool(cands), "events": record(cands), **result}


def heard(text: str, confidence: float, language: str, via: str, source: Source = Source.voice) -> dict:
    """A transcript from any voice path (live mic, uploaded clip, simulated) -> ledger + transcript feed."""
    flags = ["simulated_voice"] if via == "simulated" else None
    result = handle_text(text, source, heard_confidence=confidence, extra_flags=flags)
    recent_transcripts.append({"text": text, "confidence": round(confidence, 2), "language": language,
                               "via": via, "engine": result["engine"], "events": len(result["events"])})
    return result


def handle_utterance(audio: np.ndarray) -> None:
    """Called by the mic worker for every speech segment. Raw audio is dropped after this.
    Errors propagate to the mic listener, which counts them and shows them in /health."""
    lexicon.reload_if_changed()
    model = _model_call("speech-to-text", asr)
    t = _model_call("speech-to-text", lambda: model.transcribe(audio, hotwords=lexicon.hotwords()))
    if t is not None:
        heard(t.text, t.confidence, t.language, via="mic")


def handle_audio_file(data: bytes) -> dict:
    """A pre-recorded clip (backup demo, bake-off) through the same ASR as the live mic."""
    lexicon.reload_if_changed()
    model = _model_call("speech-to-text", asr)
    t = _model_call("speech-to-text", lambda: model.transcribe_file(data, hotwords=lexicon.hotwords()))
    if t is None:
        return {"transcript": None, "events": [], "engine": None, "is_transaction": False, "asr": model.name}
    return {"transcript": t.text, "confidence": round(t.confidence, 2), "asr": model.name,
            **heard(t.text, t.confidence, t.language, via="clip")}


# --- human decisions: stored as new events -------------------------------------------------------
def _by_id(event_id: str) -> Event:
    ev = next((e for e in store.all() if e.id == event_id), None)
    if ev is None:
        raise KeyError(event_id)
    return ev


def resolve_conflict(ids: list[str], amount_rupees: float) -> dict:
    """Settle a suspense item: one vendor-confirmed event replaces the disputed claims."""
    conflict = next((c for c in fuse(store.all()).conflicts if sorted(c["ids"]) == sorted(ids)), None)
    if conflict is None:
        raise KeyError("no open conflict with these ids")
    first = _by_id(conflict["ids"][0])
    cand = CandidateEvent(kind=first.kind, source=Source.manual, confidence=1.0,
                          party=conflict["party"], amount_rupees=amount_rupees,
                          raw="settled dispute: Rs{:g} vs Rs{:g} -> Rs{:g}".format(
                              *(c / 100 for c in conflict["claims_paise"]), amount_rupees))
    return {"events": record([cand], supersedes=sorted(ids))}


def void(event_id: str) -> dict:
    """Withdraw a wrong entry (misheard, typo). The original stays in the log, it just stops counting."""
    _by_id(event_id)
    ev = store.append_local(kind=Kind.adjustment, source=Source.manual, postings=[],
                            payload={"voided": event_id}, raw=f"void {event_id}", supersedes=[event_id])
    return {"events": [ev.model_dump(mode="json")]}


CORRECTABLE = ("kind", "item", "qty", "unit", "amount_rupees", "party", "direction")


def correct(event_id: str, changes: dict) -> dict:
    """Fix or classify an entry (wrong amount, unclassified bank money -> repayment, ...). The vendor's
    version replaces the original with full confidence; the original stays in the log."""
    old = _by_id(event_id)
    fields = {k: old.payload.get(k) for k in CORRECTABLE if k != "kind"}
    fields.update({k: v for k, v in changes.items() if k in CORRECTABLE and k != "kind"})
    kind = Kind(changes.get("kind", old.kind))
    if kind != Kind.adjustment:
        fields["direction"] = None
    cand = CandidateEvent(kind=kind, source=Source.manual, confidence=1.0, flags=["corrected"],
                          raw=f"correction of {event_id}", **fields)
    return {"events": record([cand], supersedes=[event_id])}


def separate(ids: list[str]) -> dict:
    """Vendor says: these are different trades (not one trade seen twice, not one disputed payment)."""
    for i in ids:
        _by_id(i)
    ev = store.append_local(kind=Kind.adjustment, source=Source.manual, postings=[],
                            payload={"separate": sorted(ids)}, raw=f"separate trades: {', '.join(ids)}")
    return {"events": [ev.model_dump(mode="json")]}
