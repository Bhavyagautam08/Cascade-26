from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    device_id: str = "phone-1"
    db_path: str = "data/ledger-phone-1.db"
    lexicon_path: str = "data/lexicon.json"

    # real: Whisper + Ollama models. demo: same interfaces, no models (stand-ins in perception/demo.py)
    model_mode: str = "real"

    ollama_host: str = "http://127.0.0.1:11434"
    # Must be a non-thinking model: the plain "qwen3-vl:4b" tag is the Thinking variant and returns empty JSON
    llm_model: str = "qwen3-vl:4b-instruct"

    # Whisper "small" is the only speech model. A name is looked up in the user's Hugging Face cache
    # (%USERPROFILE%\.cache\huggingface) and downloaded there once if missing; a folder holding
    # model.bin also works. If CUDA fails, the same model runs on the CPU (reported in /health).
    whisper_model: str = "small"
    whisper_device: str = "cuda"
    whisper_compute_type: str = "int8_float16"
    # "en" on purpose, for Hinglish shop talk. Auto-detect picks Hindi, and Hindi mode writes Devanagari
    # (mostly garbled on real clips), which the lexicon, rule parser and number cross-check can't read.
    # English mode + lexicon hotwords writes Roman Hinglish with digits ("1 kilo pyaj, aadha kilo
    # tomato, 250 gram achar") - measured on eval/samples/audio 101-103. "" = auto-detect.
    whisper_language: str = "en"

    whisper_preload: bool = True           # load + warm Whisper at startup (first call costs ~20 s)
    llm_max_confidence: float = 0.85       # the LLM's self-reported confidence is uncalibrated: cap it

    mic_enabled: bool = False              # start listening when the backend starts (the UI can start/stop it too)
    mic_device: str = ""                   # mic name as listed by /mic/devices; "" = the system default mic
    mic_device_index: int | None = None    # deprecated (indexes change when a headset is plugged in); ignored
    mic_min_threshold: float = 0.01        # floor of the adaptive loudness gate (see perception/mic.py)
    voice_repeat_window_s: float = 60.0    # the same trade heard again within this many seconds is booked once
    voice_min_clarity: float = 0.25        # heard less clearly than this: shown, not booked until the vendor says so

    peers: str = ""  # comma-separated base URLs of other devices
    # Sync with the peers every this many seconds, and right after any new entry (see sync/engine.py).
    # 0 = only when asked (Sync now). Short on purpose: it bounds how far apart two phones' entries can be.
    sync_interval_s: float = 5.0
    # Shared secret of the family's devices. When set, /sync/* requires it (X-Sync-Key header).
    sync_key: str = ""
    # The UI endpoints (ingest, ledger edits, lexicon) answer only this laptop unless this is true.
    allow_remote_ui: bool = False

    # Simulate a hostile device clock without touching the OS clock: off | 1970 | jump
    hostile_clock: str = "off"

    @field_validator("mic_device_index", mode="before")
    @classmethod
    def _blank_is_default_mic(cls, v):
        return None if v == "" else v   # "MIC_DEVICE_INDEX=" in .env means the system default mic

    def whisper_ref(self, value: str) -> str:
        """Model name or folder -> what faster-whisper should load.

        A plain name ("small") is resolved by faster-whisper through the user's Hugging Face cache.
        A folder must hold model.bin; relative folders resolve against backend/.
        """
        folder = self.resolve(value)
        if folder.is_dir():
            if not (folder / "model.bin").exists():
                raise FileNotFoundError(f"Whisper model folder {folder} has no model.bin (see docs/SETUP.md)")
            return str(folder)
        return value   # "small", or a Hugging Face repo id like "Systran/faster-whisper-small"

    def resolve(self, rel: str) -> Path:
        p = Path(rel)
        return p if p.is_absolute() else BACKEND_DIR / p

    @property
    def demo(self) -> bool:
        return self.model_mode.lower() == "demo"

    @property
    def peer_urls(self) -> list[str]:
        return [u.strip().rstrip("/") for u in self.peers.split(",") if u.strip()]


settings = Settings()
