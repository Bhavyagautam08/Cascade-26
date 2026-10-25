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
        """Words Whisper should expect: the Hindi/local item names and customer names only.

        Measured on eval/samples/audio: these keep "pyaj, bhindi, aadha kilo, achar" in Roman script.
        Units (g, gm, ml, ltr...) must NOT be listed - short tokens make Whisper repeat them
        ("100 gm gm gm gm", "ltr liter ml"); English names add nothing Whisper doesn't know.
        """
        local = [k for k, v in self.data.get("items", {}).items() if k.lower() != str(v).lower()]
        return " ".join(local + list(self.data.get("aliases", {})))

    def prompt_block(self) -> str:
        return json.dumps(self.data, ensure_ascii=False)
