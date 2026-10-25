"""Speech-to-text with faster-whisper "small", fully local.

Weights live in the user's Hugging Face cache (%USERPROFILE%\\.cache\\huggingface), never in the project.
"""
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


def _whisper_model_class():
    """Import faster-whisper even where PyAV can't load.

    Windows Smart App Control blocks PyAV's unsigned DLLs. faster-whisper only uses PyAV to decode
    audio *files*; the live mic hands it float32 arrays, so a placeholder module is enough, and
    clips are decoded by _decode_wav below instead.
    """
    global _HAVE_AV
    _add_cuda_dll_dirs()
    try:
        import av  # noqa: F401
    except ImportError:
        import sys
        import types
        sys.modules["av"] = types.ModuleType("av")
        _HAVE_AV = False
    from faster_whisper import WhisperModel
    return WhisperModel


_HAVE_AV = True


class UnsupportedAudio(ValueError):
    """The uploaded clip can't be decoded on this machine."""


def _add_cuda_dll_dirs() -> None:
    """Let CTranslate2 find cuBLAS/cuDNN from the nvidia-*-cu12 pip wheels (Windows doesn't look there)."""
    import os
    import sys
    from pathlib import Path

    if sys.platform != "win32":
        return
    for site in map(Path, sys.path):
        for bin_dir in (site / "nvidia").glob("*/bin"):
            os.add_dll_directory(str(bin_dir))
            os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ['PATH']}"


def _decode_wav(data: bytes) -> np.ndarray:
    """WAV -> float32 mono 16 kHz with the standard library (used when PyAV is unavailable)."""
    import wave
    from math import gcd

    from scipy.signal import resample_poly

    try:
        with wave.open(BytesIO(data)) as w:
            sr, ch, width, frames = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.readframes(w.getnframes())
    except wave.Error as e:
        raise UnsupportedAudio("only WAV clips can be decoded on this machine (PyAV is blocked)") from e
    if width not in (1, 2, 4):
        raise UnsupportedAudio(f"unsupported WAV sample width: {width} bytes")
    pcm = np.frombuffer(frames, dtype={1: np.uint8, 2: np.int16, 4: np.int32}[width]).astype(np.float32)
    pcm = (pcm - 128) / 128 if width == 1 else pcm / float(2 ** (8 * width - 1))
    pcm = pcm.reshape(-1, ch).mean(axis=1)
    g = gcd(sr, 16_000)
    return resample_poly(pcm, 16_000 // g, sr // g).astype(np.float32) if sr != 16_000 else pcm


# Known Whisper hallucinations on noise/silence
_BLOCKLIST = ("thanks for watching", "subscribe", "thank you for watching")


def _model_folder(model: str) -> str:
    """Folder with the model's weights. Names resolve in the user's Hugging Face cache; a missing
    model is downloaded into that cache once (the only step that needs internet)."""
    from pathlib import Path

    if Path(model).is_dir():
        return model
    from faster_whisper.utils import download_model

    try:
        return download_model(model, local_files_only=True)
    except Exception:  # not cached yet -> fetch once into the same cache
        return download_model(model)


class ASR:
    def __init__(self, model: str, device: str, compute_type: str):
        WhisperModel = _whisper_model_class()  # imported lazily: heavy, needs CUDA libs

        self.source = _model_folder(model)
        self.model = WhisperModel(self.source, device=device, compute_type=compute_type)
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
        """A recorded clip, decoded to 16 kHz mono (any format via PyAV, else WAV only)."""
        if not _HAVE_AV:
            return self.transcribe(_decode_wav(data), hotwords)
        from faster_whisper import decode_audio

        return self.transcribe(decode_audio(BytesIO(data), sampling_rate=16_000), hotwords)
