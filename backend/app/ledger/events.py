"""Event model. Every fact the system learns is one immutable, self-balancing event.

Money is stored as integer paise to avoid float rounding in the ledger.
"""
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class Source(str, Enum):
    voice = "voice"
    slip = "slip"
    sms = "sms"
    tally = "tally"
    manual = "manual"


class Kind(str, Enum):
    purchase = "purchase"            # bought stock from wholesaler
    sale = "sale"                    # sold plates / items
    credit_given = "credit_given"    # customer took on credit (udhaar)
    credit_paid = "credit_paid"      # customer paid back (jama)
    expense = "expense"              # gas, rent, transport...
    stock_count = "stock_count"      # observed remaining stock
    order = "order"                  # items asked for / bought with no price yet: recorded, no money moves
    opening_stock = "opening_stock"  # stock already on hand at the start of the day (morning inventory)
    adjustment = "adjustment"        # unclassified money (direction set), voids, "not a duplicate" markers


class Posting(BaseModel):
    account: str          # e.g. "cash", "inventory:tomato", "receivable:sharma", "suspense"
    amount: int           # paise; debit > 0, credit < 0


class Event(BaseModel):
    id: str                                   # f"{device_id}:{seq}"
    device_id: str
    seq: int                                  # per-device counter, never reused
    vclock: dict[str, int]                    # what this device had seen when it created the event
    wall_time: float | None = None            # untrusted: devices may jump to 1970
    kind: Kind
    source: Source
    confidence: float = Field(1.0, ge=0.0, le=1.0)
    payload: dict[str, Any] = Field(default_factory=dict)   # item, qty, unit, party, ...
    postings: list[Posting] = Field(default_factory=list)
    raw: str | None = None                    # transcript / OCR text it came from
    supersedes: list[str] = Field(default_factory=list)     # ids this event corrects or merges

    @model_validator(mode="after")
    def _balanced(self) -> "Event":
        total = sum(p.amount for p in self.postings)
        if total != 0:
            raise ValueError(f"event {self.id} is unbalanced by {total} paise")
        return self


class CandidateEvent(BaseModel):
    """What perception proposes before it becomes a ledger event."""
    kind: Kind
    source: Source
    confidence: float = Field(ge=0.0, le=1.0)
    item: str | None = None
    qty: float | None = None
    unit: str | None = None
    amount_rupees: float | None = None
    party: str | None = None                  # customer / supplier name or alias
    direction: Literal["in", "out"] | None = None   # money whose purpose is unknown (bank SMS): parked in suspense
    flags: list[str] = Field(default_factory=list)  # why this needs a human look (priced_from_list, ...)
    raw: str | None = None
