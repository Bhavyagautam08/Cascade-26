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
    llm_model: str = "qwen3-vl:4b"

    # Whisper: a model name or a folder holding model.bin. For a name, backend/models/whisper-<name> is used
    # when present (no path setting needed); otherwise faster-whisper fetches it once from Hugging Face.
    whisper_model: str = "large-v3-turbo"
    whisper_device: str = "cuda"
    whisper_compute_type: str = "int8_float16"
    whisper_fallback_model: str = "small"   # CPU fallback if CUDA is unavailable

    whisper_preload: bool = True           # load + warm Whisper at startup (first call costs ~20 s)
    llm_max_confidence: float = 0.85       # the LLM's self-reported confidence is uncalibrated: cap it

    mic_enabled: bool = False
    mic_device_index: int | None = None
    mic_min_threshold: float = 0.01        # floor of the adaptive loudness gate (see perception/mic.py)

    peers: str = ""  # comma-separated base URLs of other devices
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
        """Model name or folder -> what faster-whisper should load. Relative folders resolve against backend/."""
        if "/" in value or "\\" in value:
            folder = self.resolve(value)
            if not (folder / "model.bin").exists():
                raise FileNotFoundError(f"Whisper model folder {folder} has no model.bin (see docs/SETUP.md)")
            return str(folder)
        local = BACKEND_DIR / "models" / f"whisper-{value}"
        return str(local) if (local / "model.bin").exists() else value

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
