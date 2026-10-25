from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    device_id: str = "phone-1"
    db_path: str = "data/ledger-phone-1.db"
    lexicon_path: str = "data/lexicon.json"

    ollama_host: str = "http://127.0.0.1:11434"
    llm_model: str = "qwen3-vl:4b"

    whisper_model: str = "large-v3-turbo"
    whisper_device: str = "cuda"
    whisper_compute_type: str = "int8_float16"

    mic_enabled: bool = False
    mic_device_index: int | None = None

    peers: str = ""  # comma-separated base URLs of other devices

    def resolve(self, rel: str) -> Path:
        p = Path(rel)
        return p if p.is_absolute() else BACKEND_DIR / p

    @property
    def peer_urls(self) -> list[str]:
        return [u.strip().rstrip("/") for u in self.peers.split(",") if u.strip()]


settings = Settings()
