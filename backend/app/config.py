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

    whisper_model: str = "large-v3-turbo"   # model name, or a local folder holding model.bin
    whisper_device: str = "cuda"
    whisper_compute_type: str = "int8_float16"
    whisper_fallback_model: str = "small"   # CPU fallback if CUDA is unavailable

    mic_enabled: bool = False
    mic_device_index: int | None = None

    peers: str = ""  # comma-separated base URLs of other devices

    # Simulate a hostile device clock without touching the OS clock: off | 1970 | jump
    hostile_clock: str = "off"

    @field_validator("mic_device_index", mode="before")
    @classmethod
    def _blank_is_default_mic(cls, v):
        return None if v == "" else v   # "MIC_DEVICE_INDEX=" in .env means the system default mic

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
