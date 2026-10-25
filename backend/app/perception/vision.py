"""Read a crumpled / stained wholesale slip with a local vision model via Ollama.

TODO(stage 3): tune prompt in the bake-off (qwen3-vl:4b-instruct vs gemma3:4b); return per-line confidence so
the UI can ask the vendor to confirm doubtful lines.
"""
from pydantic import BaseModel


class SlipLine(BaseModel):
    item: str
    qty: float | None = None
    unit: str | None = None
    amount_rupees: float | None = None
    confidence: float


class Slip(BaseModel):
    supplier: str | None = None
    lines: list[SlipLine]
    total_rupees: float | None = None


PROMPT = """This is a photo of a handwritten Indian wholesale bill (may be crumpled, stained, Hindi or English).
supplier: the shop or trader name written at the top, or null.
lines: one entry per item bought. Do not include the total as a line.
total_rupees: the bill's total if written, else null.
If a value is unreadable, use null and a low confidence. Do not guess numbers."""

# Words a model may still emit as a "line" although they are the bill's total
TOTAL_WORDS = {"total", "grand total", "total amount", "kul", "jod", "yog", "net total"}


def normalize(slip: Slip, lex: dict) -> Slip:
    """Make slip lines match the ledger's vocabulary, so a slip's tomatoes and a spoken "tamatar" land
    in the same inventory account. A "Total" row becomes total_rupees instead of a purchase."""
    items = {k.lower(): v for k, v in lex.get("items", {}).items()}
    items.update({v.lower(): v for v in lex.get("items", {}).values()})
    units = {k.lower(): v for k, v in lex.get("units", {}).items()}
    lines = []
    total = slip.total_rupees
    for line in slip.lines:
        name = line.item.strip().lower()
        if name in TOTAL_WORDS:
            total = total if total is not None else line.amount_rupees
            continue
        unit, qty = line.unit, line.qty
        if unit and unit.strip().lower() in units:
            u = units[unit.strip().lower()]
            unit, qty = u["unit"], (qty * u["factor"] if qty is not None else None)
        lines.append(line.model_copy(update={"item": items.get(name, name), "unit": unit.lower() if unit else unit,
                                             "qty": qty}))
    return slip.model_copy(update={"lines": lines, "total_rupees": total})


class SlipReader:
    def __init__(self, host: str, model: str):
        from ollama import Client

        self.client = Client(host=host)
        self.model = self.name = model

    def read(self, image_bytes: bytes) -> Slip:
        resp = self.client.chat(
            model=self.model,
            messages=[{"role": "user", "content": PROMPT, "images": [image_bytes]}],
            format=Slip.model_json_schema(),
            options={"temperature": 0, "num_predict": 2048},   # a long slip has many lines
            think=False,   # needs a non-thinking model (qwen3-vl:4b-instruct); see extractor.py
        )
        return Slip.model_validate_json(resp.message.content)
