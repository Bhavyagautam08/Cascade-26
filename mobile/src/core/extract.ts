// The language model's answer -> candidate events. Mirrors backend/app/perception/extractor.py: the
// answer must match LLMOutput (pydantic); anything else is ModelOutputInvalid, never patched up.
import type { CandidateEvent, Kind, Source } from './events';
import { ModelOutputInvalid } from './ledger';

const LLM_KINDS: Kind[] = ['purchase', 'sale', 'credit_given', 'credit_paid', 'expense', 'stock_count', 'order'];

const isNum = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
const optStr = (x: unknown) => x === undefined || x === null || typeof x === 'string';
const optNum = (x: unknown) => x === undefined || x === null || isNum(x);

/** Parse and validate the model's JSON (LLMOutput), then build CandidateEvents (extractor.from_text). */
export function parseExtraction(json: string, text: string, source: Source): { is_transaction: boolean; events: CandidateEvent[] } {
  let out: any;
  try {
    out = JSON.parse(json);
  } catch (e) {
    throw new ModelOutputInvalid(`the model's answer is not JSON (${(e as Error).message}): ${json.slice(0, 160)}`);
  }
  const bad = (why: string) => new ModelOutputInvalid(`the model answered outside the schema: ${why}`);
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw bad('not an object');
  if (typeof out.is_transaction !== 'boolean') throw bad('is_transaction must be true/false');
  if (!Array.isArray(out.events)) throw bad('events must be a list');
  const events: CandidateEvent[] = out.events.map((e: any, i: number) => {
    if (!e || typeof e !== 'object') throw bad(`event ${i} is not an object`);
    if (!LLM_KINDS.includes(e.kind)) throw bad(`event ${i} has kind ${JSON.stringify(e.kind)}`);
    if (!optStr(e.item) || !optStr(e.unit) || !optStr(e.party)) throw bad(`event ${i}: item/unit/party must be text or null`);
    if (!optNum(e.qty) || !optNum(e.amount_rupees)) throw bad(`event ${i}: qty/amount must be numbers or null`);
    if (!isNum(e.confidence) || e.confidence < 0 || e.confidence > 1) throw bad(`event ${i}: confidence must be 0..1`);
    return {
      kind: e.kind, source, confidence: e.confidence, item: e.item ?? null, qty: e.qty ?? null, unit: e.unit ?? null,
      amount_rupees: e.amount_rupees ?? null, party: e.party ?? null, direction: null, flags: [], raw: text,
    } as CandidateEvent;
  });
  return { is_transaction: out.is_transaction && events.length > 0, events };
}
