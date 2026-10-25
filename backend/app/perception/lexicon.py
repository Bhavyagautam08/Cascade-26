"""Vocabulary and units, loaded from a JSON file that can change while the app runs (Lexicon Drop).

The same lexicon feeds Whisper (as hotwords) and the LLM extractor (in the prompt), so one edit
updates both.
"""
import json
from pathlib import Path
from threading import Lock


class Lexicon:
    def __init__(self, path: Path):
        self.path = path
        self._lock = Lock()
        self._mtime = 0.0
        self.data: dict = {"items": {}, "units": {}, "aliases": {}}
        self.reload_if_changed()

    def reload_if_changed(self) -> bool:
        mtime = self.path.stat().st_mtime if self.path.exists() else 0.0
        if mtime == self._mtime:
            return False
        with self._lock:
            self.data = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else self.data
            self._mtime = mtime
        return True

    def add(self, section: str, key: str, value) -> None:
        """Add one entry at runtime and persist it."""
        with self._lock:
            current = self.data.setdefault(section, {})
            if isinstance(current, list):          # e.g. "perishable": ["tomato", ...]
                if key not in current:
                    current.append(key)
            else:
                current[key] = value
            self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
            self._mtime = self.path.stat().st_mtime

    def hotwords(self) -> str:
        words = list(self.data.get("items", {})) + list(self.data.get("units", {})) + list(self.data.get("aliases", {}))
        return " ".join(words)

    def prompt_block(self) -> str:
        return json.dumps(self.data, ensure_ascii=False)
