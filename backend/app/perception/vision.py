"""Read a crumpled / stained wholesale slip with a local vision model via Ollama.

TODO(stage 3): tune prompt in the bake-off (qwen3-vl:4b vs gemma3:4b); return per-line confidence so
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
Read every line item. If a value is unreadable, use null and a low confidence. Do not guess numbers."""


class SlipReader:
    def __init__(self, host: str, model: str):
        from ollama import Client

        self.client = Client(host=host)
        self.model = model

    def read(self, image_bytes: bytes) -> Slip:
        resp = self.client.chat(
            model=self.model,
            messages=[{"role": "user", "content": PROMPT, "images": [image_bytes]}],
            format=Slip.model_json_schema(),
            options={"temperature": 0},
        )
        return Slip.model_validate_json(resp.message.content)
