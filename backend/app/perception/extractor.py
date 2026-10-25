"""Text (transcript / OCR / SMS) -> candidate ledger events, using a local LLM via Ollama.

The model sees a small schema with only the fields it should fill (not the internal flags, source or
raw text), plus a few worked examples. Its JSON is enforced with Ollama structured outputs, validated
with pydantic, then converted to CandidateEvents. pipeline.cross_check afterwards removes any amount
that was not actually said.
"""
from typing import Literal

from pydantic import BaseModel, Field

from app.ledger.events import CandidateEvent, Kind, Source
from app.perception.lexicon import Lexicon


class Extraction(BaseModel):
    is_transaction: bool
    events: list[CandidateEvent]


class LLMEvent(BaseModel):
    """What the model is asked to produce for one trade."""
    kind: Literal["purchase", "sale", "credit_given", "credit_paid", "expense", "stock_count", "order"]
    item: str | None = None
    qty: float | None = None
    unit: str | None = None
    amount_rupees: float | None = None
    party: str | None = None
    confidence: float = Field(ge=0.0, le=1.0)


class LLMOutput(BaseModel):
    is_transaction: bool
    events: list[LLMEvent]


SYSTEM = """You turn a street vendor's shop talk (Hindi/English/Hinglish) into ledger events.

Event kinds:
- purchase: the vendor bought stock (liya, laya, kharida). party = the supplier only if named.
- sale: the vendor sold to a customer for cash (de, diya, becha).
- credit_given: a customer took goods on credit / udhaar (udhaar, baaki, likh). party = the customer.
- credit_paid: a customer paid back money they owed (jama, chukaya). party = the customer.
- expense: the vendor paid for gas, rent, transport (kharcha, bhara).
- stock_count: the vendor counted what is left (bacha, bache). qty = what is left.
- order: items asked for or ordered with no price said (chahiye, bhej do, a list of items with
  quantities). One order event per item, with its qty and unit.

Rules:
- One event per trade; a sentence can hold several trades. A list of items with quantities is a
  trade (one order event per item), even without a price. Chatter is not a transaction:
  return is_transaction=false and no events.
- item, unit and party are normalised with the lexicon (e.g. tamatar -> tomato, "sharma ji" -> sharma).
  Only map a word that is itself in the lexicon; otherwise keep the item words as said
  (e.g. "brown bread" stays "brown bread", never a similar lexicon item). A party belongs only to
  the trade in the same clause.
- Spoken numbers come from the lexicon's numbers (e.g. sau = 100, so "sau gram" is 100 g = 0.1 kg).
- qty is the number right before a unit word (kilo, plate, cup, packet...), converted with the
  lexicon's unit factor. unit is the lexicon's unit (kg, l, plate, packet).
- amount_rupees is the money actually said for that trade. If no money was said, use null.
  Never compute or guess an amount.
- confidence: how sure you are about this event, 0 to 1.

Examples:
text: "4 kilo aloo liya 120 mein"
{{"is_transaction": true, "events": [{{"kind": "purchase", "item": "potato", "qty": 4, "unit": "kg", "amount_rupees": 120, "party": null, "confidence": 0.9}}]}}
text: "gupta ji ka 25 jama, aur 3 cup chai de"
{{"is_transaction": true, "events": [{{"kind": "credit_paid", "item": null, "qty": null, "unit": null, "amount_rupees": 25, "party": "gupta", "confidence": 0.9}}, {{"kind": "sale", "item": "tea", "qty": 3, "unit": "plate", "amount_rupees": null, "party": null, "confidence": 0.8}}]}}
text: "ramesh ka 45 udhaar likh"
{{"is_transaction": true, "events": [{{"kind": "credit_given", "item": null, "qty": null, "unit": null, "amount_rupees": 45, "party": "ramesh", "confidence": 0.85}}]}}
text: "bhai do kilo besan aur paanch sau gram jeera chahiye"
{{"is_transaction": true, "events": [{{"kind": "order", "item": "gram flour", "qty": 2, "unit": "kg", "amount_rupees": null, "party": null, "confidence": 0.85}}, {{"kind": "order", "item": "cumin", "qty": 0.5, "unit": "kg", "amount_rupees": null, "party": null, "confidence": 0.85}}]}}
text: "baarish ho rahi hai, dukaan jaldi band karenge"
{{"is_transaction": false, "events": []}}

Lexicon: {lexicon}"""


class Extractor:
    def __init__(self, host: str, model: str, lexicon: Lexicon):
        from ollama import Client

        self.client = Client(host=host)
        self.model = self.name = model
        self.lexicon = lexicon

    def from_text(self, text: str, source: Source) -> Extraction:
        self.lexicon.reload_if_changed()
        resp = self.client.chat(
            model=self.model,
            messages=[
                {"role": "system", "content": SYSTEM.format(lexicon=self.lexicon.prompt_block())},
                {"role": "user", "content": f"text: {text}"},
            ],
            format=LLMOutput.model_json_schema(),
            # num_predict bounds a runaway answer; an answer cut off by it fails schema validation (502)
            options={"temperature": 0, "num_predict": 1024},
            # Needs a non-thinking model (qwen3-vl:4b-instruct). Thinking variants such as qwen3-vl:4b
            # ignore this flag, reason until num_predict runs out and return empty content.
            think=False,
        )
        out = LLMOutput.model_validate_json(resp.message.content)
        events = [CandidateEvent(**e.model_dump(exclude={"kind"}), kind=Kind(e.kind), source=source, raw=text)
                  for e in out.events]
        return Extraction(is_transaction=out.is_transaction and bool(events), events=events)
