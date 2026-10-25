"""Stand-ins for the three models, used when MODEL_MODE=demo (models not installed yet, or a laptop
without a GPU that still wants to show the full flow).

Each class has exactly the interface of the real one, so pipeline.py swaps them with one setting:

  DemoASR        ~ asr.ASR              transcribe(audio, hotwords), transcribe_file(bytes, hotwords)
  DemoExtractor  ~ extractor.Extractor  from_text(text, source)     -> Extraction
  DemoSlipReader ~ vision.SlipReader    read(image_bytes)           -> Slip

Nothing here pretends to understand audio or images: DemoASR plays back a script, DemoSlipReader
returns one fixed sample slip, and DemoExtractor is the rule parser behind the LLM's interface.
Every response is labelled "demo" in the API so it can't be mistaken for model output.
"""
from itertools import cycle
from pathlib import Path

import numpy as np

from app.ledger.events import Source
from app.perception import rules
from app.perception.asr import Transcript
from app.perception.extractor import Extraction
from app.perception.lexicon import Lexicon
from app.perception.vision import Slip, SlipLine


class DemoASR:
    name = "demo"

    def __init__(self, script_path: Path):
        lines = script_path.read_text(encoding="utf-8").splitlines() if script_path.exists() else []
        lines = [ln.strip() for ln in lines if ln.strip() and not ln.startswith("#")]
        self._lines = cycle(lines or ["Bhai 3 kilo tamatar liya 180 mein"])

    def transcribe(self, audio: np.ndarray, hotwords: str | None = None) -> Transcript | None:
        if audio.size == 0:
            return None
        return Transcript(text=next(self._lines), language="demo", avg_logprob=-0.2, no_speech_prob=0.05)

    def transcribe_file(self, data: bytes, hotwords: str | None = None) -> Transcript | None:
        return self.transcribe(np.frombuffer(data[:4], dtype=np.uint8), hotwords)


class DemoExtractor:
    name = "demo"

    def __init__(self, lexicon: Lexicon):
        self.lexicon = lexicon

    def from_text(self, text: str, source: Source) -> Extraction:
        self.lexicon.reload_if_changed()
        events = rules.parse(text, self.lexicon.data, source)
        for ev in events:
            ev.raw = text
        return Extraction(is_transaction=bool(events), events=events)


# A typical stained wholesale slip: two clear lines, one half-legible, one smudged out.
_SAMPLE_SLIP = Slip(
    supplier="Gupta Traders",
    lines=[
        SlipLine(item="tomato", qty=10, unit="kg", amount_rupees=300, confidence=0.93),
        SlipLine(item="onion", qty=5, unit="kg", amount_rupees=150, confidence=0.88),
        SlipLine(item="coriander", qty=0.5, unit="kg", amount_rupees=20, confidence=0.55),
        SlipLine(item="oil", qty=2, unit="l", amount_rupees=None, confidence=0.31),
    ],
    total_rupees=690,
)


class DemoSlipReader:
    name = "demo"

    def read(self, image_bytes: bytes) -> Slip:
        return _SAMPLE_SLIP.model_copy(deep=True)
