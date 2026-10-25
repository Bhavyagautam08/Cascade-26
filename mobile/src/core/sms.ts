// Bank / UPI transaction SMS -> one money movement. Deterministic, no model. Ported from perception/sms.py.
//
// Machine-written, so amount and direction are exact, but they never say WHY money moved. The pipeline
// decides: money in from a customer who owes us -> repayment (jama); anything else waits in suspense.
//   "Rs.140 credited to a/c XX12 from CHHOTU via UPI" -> in, 140, chhotu
//   "INR 250.00 debited for Gupta Traders"             -> out, 250, gupta traders
const AMOUNT = /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i;
const IN = /\b(credited|received|deposited|recd)\b/i;
const OUT = /\b(debited|paid|sent|withdrawn|transferred)\b/i;
const STOP = String.raw`(?=\s+(?:on|via|ref|upi|vpa|imps|neft|thru|through|by|a/c|ac|avl|bal)\b|\s*[.,;()]|\s*$)`;
const FROM = new RegExp(String.raw`\bfrom\s+(?:vpa\s+)?([a-z][\w&'@ -]*?)${STOP}`, 'gi');
const TO = new RegExp(String.raw`\b(?:to|for|at)\s+(?:vpa\s+)?([a-z][\w&'@ -]*?)${STOP}`, 'gi');
const NOT_A_PARTY = ['your', 'a/c', 'ac ', 'account', 'acct', 'you', 'xx'];

export type BankTxn = { direction: 'in' | 'out'; amount_rupees: number; party: string | null };

function partyFrom(pattern: RegExp, text: string): string | null {
  for (const m of text.matchAll(pattern)) {
    const name = m[1].trim().toLowerCase();
    if (name && !NOT_A_PARTY.some((p) => name.startsWith(p))) return name;
  }
  return null;
}

/** null if this isn't a bank / UPI transaction message. */
export function parseSms(text: string): BankTxn | null {
  const amount = AMOUNT.exec(text);
  const mIn = IN.exec(text);
  const mOut = OUT.exec(text);
  if (!amount || !(mIn || mOut)) return null;
  // The first direction word decides ("debited from your a/c ... credited to X" is money out).
  const direction = mIn && (!mOut || mIn.index < mOut.index) ? 'in' : 'out';
  return { direction, amount_rupees: Number(amount[1].replace(/,/g, '')), party: partyFrom(direction === 'in' ? FROM : TO, text) };
}
