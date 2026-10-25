"""Point the app at a throwaway database and lexicon copy before anything imports app.config."""
import os
import shutil
import tempfile
from pathlib import Path

_tmp = Path(tempfile.mkdtemp(prefix="iw-test-"))
shutil.copy(Path(__file__).parent.parent / "data" / "lexicon.json", _tmp / "lexicon.json")
os.environ.update({
    "DEVICE_ID": "phone-1",
    "DB_PATH": str(_tmp / "ledger.db"),
    "LEXICON_PATH": str(_tmp / "lexicon.json"),
    "MODEL_MODE": "demo",
    "MIC_ENABLED": "false",
    "PEERS": "",
    "HOSTILE_CLOCK": "off",
})
