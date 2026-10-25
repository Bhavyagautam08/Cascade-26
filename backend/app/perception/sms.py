"""Bank / UPI transaction SMS -> one money movement. Deterministic, no model.

These messages are machine-written, so the amount and direction are exact, but they never say *why*
money moved. pipeline.py decides: money in from a customer who owes us -> repayment (jama); anything
else is parked in suspense until the vendor says what it was. Nothing is guessed as a sale.

  "Rs.140 credited to a/c XX12 from CHHOTU via UPI"  -> in, 140, chhotu
  "INR 250.00 debited for Gupta Traders"              -> out, 250, gupta traders
"""
import re
from dataclasses import dataclass

_AMOUNT = re.compile(r"(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)", re.I)
_IN = re.compile(r"\b(credited|received|deposited|recd)\b", re.I)
_OUT = re.compile(r"\b(debited|paid|sent|withdrawn|transferred)\b", re.I)
_STOP = r"(?=\s+(?:on|via|ref|upi|vpa|imps|neft|thru|through|by|a/c|ac|avl|bal)\b|\s*[.,;()]|\s*$)"
_FROM = re.compile(rf"\bfrom\s+(?:vpa\s+)?([a-z][\w&'@ -]*?){_STOP}", re.I)
_TO = re.compile(rf"\b(?:to|for|at)\s+(?:vpa\s+)?([a-z][\w&'@ -]*?){_STOP}", re.I)
_NOT_A_PARTY = ("your", "a/c", "ac ", "account", "acct", "you", "xx")


@dataclass
class BankTxn:
    direction: str            # "in" | "out"
    amount_rupees: float
    party: str | None


def _party(pattern: re.Pattern, text: str) -> str | None:
    for m in pattern.finditer(text):
        name = m.group(1).strip().lower()
        if name and not name.startswith(_NOT_A_PARTY):
            return name
    return None


def parse(text: str) -> BankTxn | None:
    """None if this isn't a bank/UPI transaction message."""
    amount = _AMOUNT.search(text)
    m_in, m_out = _IN.search(text), _OUT.search(text)
    if not amount or not (m_in or m_out):
        return None
    # The first direction word decides ("debited from your a/c ... credited to X" is money out).
    direction = "in" if m_in and (not m_out or m_in.start() < m_out.start()) else "out"
    party = _party(_FROM if direction == "in" else _TO, text)
    return BankTxn(direction, float(amount.group(1).replace(",", "")), party)
