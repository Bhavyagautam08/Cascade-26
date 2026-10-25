"""Text (transcript / OCR / SMS) -> candidate ledger events, using a local LLM via Ollama.

The JSON schema is enforced with Ollama structured outputs, then validated again with pydantic.
"""
from pydantic import BaseModel

from app.ledger.events import CandidateEvent, Source
from app.perception.lexicon import Lexicon


class Extraction(BaseModel):
    is_transaction: bool
    events: list[CandidateEvent]


SYSTEM = """You turn a street vendor's shop talk (Hindi/English/Hinglish) into ledger events.
Most talk is NOT a transaction: return is_transaction=false and no events for chatter.
Use the lexicon to normalise items, units and customer aliases. Amounts are in rupees.
Never invent amounts: leave amount_rupees null if it was not said. Lower confidence when unsure.
Lexicon: {lexicon}"""


class Extractor:
    def __init__(self, host: str, model: str, lexicon: Lexicon):
        from ollama import Client

        self.client = Client(host=host)
        self.model = model
        self.lexicon = lexicon

    def from_text(self, text: str, source: Source) -> Extraction:
        self.lexicon.reload_if_changed()
        resp = self.client.chat(
            model=self.model,
            messages=[
                {"role": "system", "content": SYSTEM.format(lexicon=self.lexicon.prompt_block())},
                {"role": "user", "content": f"source={source.value}\ntext: {text}"},
            ],
            format=Extraction.model_json_schema(),
            options={"temperature": 0},
        )
        out = Extraction.model_validate_json(resp.message.content)
        for ev in out.events:
            ev.source, ev.raw = source, text
        return out
