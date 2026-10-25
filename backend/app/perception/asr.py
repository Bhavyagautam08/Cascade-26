"""Speech-to-text with faster-whisper, fully local. Model weights come from HF_HOME (E:\\ai\\hf)."""
from dataclasses import dataclass
from io import BytesIO

import numpy as np


@dataclass
class Transcript:
    text: str
    language: str
    avg_logprob: float
    no_speech_prob: float

    @property
    def confidence(self) -> float:
        # crude mapping of whisper log-prob to 0..1; tuned in the bake-off
        return float(np.clip(np.exp(self.avg_logprob), 0.0, 1.0)) * (1.0 - self.no_speech_prob)


# Known Whisper hallucinations on noise/silence
_BLOCKLIST = ("thanks for watching", "subscribe", "thank you for watching")


class ASR:
    def __init__(self, model: str, device: str, compute_type: str):
        from faster_whisper import WhisperModel  # imported lazily: heavy, needs CUDA libs

        self.model = WhisperModel(model, device=device, compute_type=compute_type)
        self.name = f"{model} ({device})"

    def transcribe(self, audio: np.ndarray, hotwords: str | None = None) -> Transcript | None:
        """audio: float32 mono 16 kHz."""
        segments, info = self.model.transcribe(
            audio,
            language=None,                   # auto: Hindi / English / mixed
            vad_filter=True,
            condition_on_previous_text=False,
            hotwords=hotwords or None,
            beam_size=5,
        )
        segs = list(segments)
        if not segs:
            return None
        text = " ".join(s.text.strip() for s in segs).strip()
        if not text or text.lower().strip(" .!") in _BLOCKLIST:
            return None
        return Transcript(
            text=text,
            language=info.language,
            avg_logprob=float(np.mean([s.avg_logprob for s in segs])),
            no_speech_prob=float(np.mean([s.no_speech_prob for s in segs])),
        )

    def transcribe_file(self, data: bytes, hotwords: str | None = None) -> Transcript | None:
        """A recorded clip (wav/mp3/m4a/ogg...), decoded to 16 kHz mono by faster-whisper's PyAV."""
        from faster_whisper import decode_audio

        return self.transcribe(decode_audio(BytesIO(data), sampling_rate=16_000), hotwords)
