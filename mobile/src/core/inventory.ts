import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { currentDay, inDay } from './days';
import { postingsFor } from './doubleentry';
import type { CandidateEvent, Event } from './events';
import type { Ledger } from './ledger';
import { pyJsonDumps, type LexiconData } from './lexicon';
import { numbersIn, phraseFind, spokenNumbers } from './rules';
import { fixItemSpelling } from './spelling';

export type InventoryMode = 'opening' | 'closing';
export type InventoryStatus = 'opening' | 'purchased' | 'unclear' | 'closing';
export type InventoryItem = {
  item: string;
  said: string;
  qty: number | null;
  unit: string | null;
  total_cost: number | null;
  unit_cost: number | null;
  status: InventoryStatus;
  confidence: number;
  flags: string[];
  question: string | null;
};
type ModelItem = {
  said: string;
  item: string;
  qty: number | null;
  unit: string | null;
  total_cost: number | null;
  status: 'opening' | 'purchased' | 'unclear';
};

export class InventoryModelInvalid extends Error {}
export class InventoryNeedsAnswers extends Error {}
export class InventoryWouldOverwrite extends Error {
  constructor(readonly existing: Event[]) {
    super(`already saved today: ${existing.map((event) => event.payload.item).join(', ')}`);
  }
}

export const INVENTORY_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          said: { type: 'string' },
          item: { type: 'string' },
          qty: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'] },
          total_cost: { type: ['number', 'null'] },
          status: { type: 'string', enum: ['opening', 'purchased', 'unclear'] },
        },
        required: ['said', 'item', 'qty', 'unit', 'total_cost', 'status'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
});

export const INVENTORY_OPENING_PROMPT = `A street vendor describes the stock they have this morning, in Hindi/English/Hinglish.
Return one entry per item mentioned. For each item:
- said: the exact words about this item.
- item: the item name, normalised with the lexicon if the word is in it (tamatar -> tomato), else as said.
- qty and unit: the number and unit word exactly as said, NOT converted ("500 gram" -> 500, "gram").
  A count of things with no unit ("100 puriyan") -> qty 100, unit "piece". No number said -> null.
- total_cost: rupees said for this item's whole quantity; null if no money was said for it.
- status: "opening" if the vendor already has it (hain, bacha hai, rakha hai, mere paas), even if it
  was bought earlier ("khareede the"); "purchased" if bought this morning/today (aaj liya, abhi laya,
  subah khareeda); "unclear" if you cannot tell.
Never invent a number. Spoken numbers come from the lexicon (sau = 100).

Example:
text: "mere paas 3 kilo pyaz hai 90 rupaye ka, aur aaj subah 2 litre doodh liya 120 mein, mirchi bhi hai"
{"items": [{"said": "3 kilo pyaz hai 90 rupaye ka", "item": "onion", "qty": 3, "unit": "kilo", "total_cost": 90, "status": "opening"}, {"said": "aaj subah 2 litre doodh liya 120 mein", "item": "milk", "qty": 2, "unit": "litre", "total_cost": 120, "status": "purchased"}, {"said": "mirchi bhi hai", "item": "chilli", "qty": null, "unit": null, "total_cost": null, "status": "opening"}]}

Lexicon: `;

export const INVENTORY_CLOSING_PROMPT = `At the end of the day a street vendor says how much stock is LEFT, in Hindi/English/Hinglish.
Return one entry per item mentioned. For each item:
- said: the exact words about this item.
- item: the item name, normalised with the lexicon if the word is in it (tamatar -> tomato), else as said.
- qty and unit: the number and unit word exactly as said, NOT converted ("500 gram" -> 500, "gram").
  A count of things with no unit ("20 puriyan") -> qty 20, unit "piece". "khatam" / nothing left -> qty 0.
  No number said -> null.
- total_cost: null. status: "opening".
Never invent a number. Spoken numbers come from the lexicon (sau = 100).

Example:
text: "shaam ko 2 kilo pyaz bacha hai, doodh khatam, aur mirchi thodi si hai"
{"items": [{"said": "2 kilo pyaz bacha hai", "item": "onion", "qty": 2, "unit": "kilo", "total_cost": null, "status": "opening"}, {"said": "doodh khatam", "item": "milk", "qty": 0, "unit": null, "total_cost": null, "status": "opening"}, {"said": "mirchi thodi si hai", "item": "chilli", "qty": null, "unit": null, "total_cost": null, "status": "opening"}]}

Lexicon: `;

const COUNT_UNITS = new Set(['piece', 'pieces', 'pc', 'pcs', 'nag', 'number']);
const BUY = new Set(['liya', 'liye', 'li', 'laya', 'laye', 'layi', 'lae', 'khareeda', 'khareede', 'khareedi', 'kharida', 'kharide', 'kharidi', 'mangwaya', 'mangwaye', 'bought']);
const EARLIER = new Set(['tha', 'the', 'thi']);
const HAVE = new Set(['hai', 'hain', 'pada', 'padi', 'pade', 'bacha', 'bachi', 'bache', 'rakha', 'rakhi', 'rakhe', 'paas', 'pehle', 'kal']);
const NONE_LEFT = new Set(['khatam', 'nahi', 'nahin', 'zero', 'nothing']);
const MONEY = /(?:₹|rs\.?|inr)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:rupaye|rupay|rupees?|rs\b|\/-)/gi;

function moneyIn(text: string): number[] {
  return [...text.matchAll(MONEY)].map((match) => Number(match[1] ?? match[2]));
}

function statusFromWords(said: string): InventoryStatus {
  const words = said.toLowerCase().match(/[a-z]+/g) ?? [];
  for (let index = 0; index < words.length; index++) {
    if (BUY.has(words[index]) && !(index + 1 < words.length && EARLIER.has(words[index + 1]))) return 'purchased';
  }
  return words.some((word) => HAVE.has(word)) ? 'opening' : 'unclear';
}

function questions(item: string, qty: number | null, unit: string | null, status: InventoryStatus, mode: InventoryMode): string[] {
  const result: string[] = [];
  if (qty === null) result.push(`${item} kitna hai?`);
  else if (unit === null && qty !== 0) result.push(`${qty} ${item}: kilo, litre ya piece?`);
  if (mode === 'opening' && status === 'unclear') result.push(`${item} aaj kharida, ya pehle se tha?`);
  return result;
}

const NUM = /^\d+(?:\.\d+)?$/;

/**
 * The stock list read by word rules, for when the language model isn't loaded (on this phone's CPU it takes
 * minutes). Each clause naming a known item becomes one row: the number before a unit (or before the item) is
 * the quantity, a number marked as money (or the one other number) is the cost. Every row then goes through
 * the same checks as the model's answer, so anything not said comes back as a question, never a guess.
 */
export function inventoryFromWords(transcript: string, lexicon: LexiconData, mode: InventoryMode): InventoryItem[] {
  const said = spokenNumbers(fixItemSpelling(transcript, lexicon).text, lexicon);
  const words: Record<string, string> = {};
  for (const [local, canonical] of Object.entries(lexicon.items ?? {})) {
    words[local.toLowerCase()] = canonical;
    words[canonical.toLowerCase()] = canonical;
  }
  const units = new Set(Object.keys(lexicon.units ?? {}).map((u) => u.toLowerCase()));
  const rows: ModelItem[] = [];
  for (const clause of said.split(/[,.;\n]+|\s+(?:aur|or|and|phir)\s+/i).map((c) => c.trim()).filter(Boolean)) {
    const lower = clause.toLowerCase();
    const key = phraseFind(lower, Object.keys(words));
    if (!key) continue;
    const toks = lower.match(/\d+(?:\.\d+)?|[a-z]+/g) ?? [];
    const itemFirst = key.split(' ')[0];
    let qty: number | null = null;
    let unit: string | null = null;
    let qtyAt = -1;
    for (let i = 0; i < toks.length && qtyAt < 0; i++) {
      if (!NUM.test(toks[i])) continue;
      const two = `${toks[i + 1]} ${toks[i + 2]}`;
      if (units.has(two)) unit = two;
      else if (units.has(toks[i + 1])) unit = toks[i + 1];
      else if (toks[i + 1] !== itemFirst) continue;
      qty = Number(toks[i]);
      qtyAt = i;
    }
    if (mode === 'closing' && qty === null && toks.some((w) => NONE_LEFT.has(w))) qty = 0;
    const money = moneyIn(clause);
    const others = toks.filter((w, i) => NUM.test(w) && i !== qtyAt).map(Number);
    const cost = money.length === 1 ? money[0] : !money.length && others.length === 1 ? others[0] : null;
    rows.push({ said: clause, item: words[key], qty, unit, total_cost: mode === 'opening' ? cost : null, status: statusFromWords(clause) as ModelItem['status'] });
  }
  return rows.map((raw) => checkModelItem(raw, said, lexicon, mode));
}

function canonicalUnit(saidUnit: string | null, qty: number | null, lexicon: LexiconData, flags: string[]): [string | null, number | null] {
  const unit = saidUnit?.trim().toLowerCase() || null;
  const conversion = unit ? lexicon.units?.[unit] : undefined;
  if (conversion) {
    const converted = qty === null ? null : Math.round(qty * conversion.factor * 1_000_000) / 1_000_000;
    return [conversion.unit.toLowerCase(), converted];
  }
  if (unit && COUNT_UNITS.has(unit)) return ['piece', qty];
  if (unit) flags.push(`unknown_unit:${unit}`);
  return [unit, qty];
}

function checkModelItem(raw: ModelItem, transcript: string, lexicon: LexiconData, mode: InventoryMode): InventoryItem {
  const saidText = raw.said.trim();
  const item = (raw.item || saidText).trim().toLowerCase();
  const heard = new Set([
    ...numbersIn(transcript, (lexicon.numbers ?? {}) as Record<string, number>),
    ...numbersIn(saidText, (lexicon.numbers ?? {}) as Record<string, number>),
  ]);
  if (mode === 'closing' && (saidText.toLowerCase().match(/[a-z]+/g) ?? []).some((word) => NONE_LEFT.has(word))) heard.add(0);
  const flags: string[] = [];
  let qty = raw.qty;
  if (qty !== null && ![...heard].some((value) => Math.abs(value - qty!) <= Math.max(1e-9, Math.abs(value) * 1e-6))) {
    flags.push(`quantity_not_heard:${qty}`);
    qty = null;
  }
  const [unit, canonicalQty] = canonicalUnit(raw.unit, qty, lexicon, flags);
  if (mode === 'closing') {
    const open = questions(item, canonicalQty, unit, 'closing', mode);
    return {
      item, said: saidText, qty: canonicalQty, unit, total_cost: null, unit_cost: null, status: 'closing',
      confidence: !flags.length && canonicalQty !== null ? 1 : 0.5, flags, question: open.join(' ') || null,
    };
  }

  let totalCost = raw.total_cost;
  if (totalCost !== null && ![...heard].some((value) => Math.abs(value - totalCost!) <= Math.max(1e-9, Math.abs(value) * 1e-6))) {
    flags.push(`cost_not_heard:${totalCost}`);
    totalCost = null;
  }
  if (totalCost === null && raw.total_cost === null) {
    const money = moneyIn(saidText);
    if (money.length === 1) {
      totalCost = money[0];
      flags.push('cost_from_words');
    }
  }
  const status = statusFromWords(saidText);
  if (status !== raw.status) flags.push(`status_from_words:${raw.status}->${status}`);
  const open = questions(item, canonicalQty, unit, status, mode);
  if (totalCost === null) flags.push('cost_missing');
  return {
    item, said: saidText, qty: canonicalQty, unit, total_cost: totalCost,
    unit_cost: totalCost !== null && canonicalQty ? Math.round((totalCost / canonicalQty) * 10_000) / 10_000 : null,
    status, confidence: !flags.length && !open.length ? 1 : open.length ? 0.5 : 0.75,
    flags, question: open.join(' ') || null,
  };
}

export function inventoryQuestion(item: InventoryItem, mode: InventoryMode): string | null {
  return questions(item.item, item.qty, item.unit, mode === 'closing' ? 'closing' : item.status, mode).join(' ') || null;
}

export function updateInventoryItem(item: InventoryItem, changes: Partial<Pick<InventoryItem, 'item' | 'qty' | 'unit' | 'total_cost' | 'status'>>, mode: InventoryMode): InventoryItem {
  const updated = { ...item, ...changes };
  const question = inventoryQuestion(updated, mode);
  const unitCost = mode === 'opening' && updated.total_cost !== null && updated.qty ? Math.round((updated.total_cost / updated.qty) * 10_000) / 10_000 : null;
  return { ...updated, unit_cost: unitCost, question };
}

export function parseInventoryAnswer(answer: string, transcript: string, lexicon: LexiconData, mode: InventoryMode): InventoryItem[] {
  let value: unknown;
  try {
    const json = answer
      .replace(/^\s*<\|im_start\|>assistant(?:\s*\n)?/, '')
      .replace(/\s*<\|im_end\|>\s*$/, '')
      .trim();
    value = JSON.parse(json);
  } catch (error) {
    throw new InventoryModelInvalid(`model answer was not valid JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as { items?: unknown }).items)) {
    throw new InventoryModelInvalid('model answer must contain an items list');
  }
  const rawItems = (value as { items: unknown[] }).items;
  const saidText = spokenNumbers(transcript, lexicon);
  return rawItems.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InventoryModelInvalid(`item ${index + 1} is not an object`);
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.said !== 'string' || !candidate.said.trim() || typeof candidate.item !== 'string' || !candidate.item.trim()) {
      throw new InventoryModelInvalid(`item ${index + 1} needs the exact words said and a non-empty item name`);
    }
    if (candidate.qty !== null && (typeof candidate.qty !== 'number' || !Number.isFinite(candidate.qty) || candidate.qty < 0)) {
      throw new InventoryModelInvalid(`item ${index + 1} quantity must be a non-negative number or null`);
    }
    if (candidate.unit !== null && typeof candidate.unit !== 'string') throw new InventoryModelInvalid(`item ${index + 1} unit must be text or null`);
    if (candidate.total_cost !== null && (typeof candidate.total_cost !== 'number' || !Number.isFinite(candidate.total_cost) || candidate.total_cost < 0)) {
      throw new InventoryModelInvalid(`item ${index + 1} cost must be a non-negative number or null`);
    }
    if (!['opening', 'purchased', 'unclear'].includes(String(candidate.status))) {
      throw new InventoryModelInvalid(`item ${index + 1} has an unknown status`);
    }
    return checkModelItem({
      said: candidate.said, item: candidate.item, qty: candidate.qty as number | null,
      unit: candidate.unit as string | null, total_cost: candidate.total_cost as number | null,
      status: candidate.status as ModelItem['status'],
    }, saidText, lexicon, mode);
  });
}

export function inventoryPrompt(lexicon: LexiconData, mode: InventoryMode): string {
  const base = mode === 'opening' ? INVENTORY_OPENING_PROMPT : INVENTORY_CLOSING_PROMPT;
  return `${base}${pyJsonDumps(lexicon)}`;
}

export function inventoryRecordingId(text: string, mode: InventoryMode): string {
  const normalized = text.trim().toLowerCase();
  return `${mode}:${bytesToHex(sha256(utf8ToBytes(normalized))).slice(0, 24)}`;
}

export function todayInventory(events: Event[], mode: InventoryMode): Event[] {
  const current = currentDay(events);
  const inCurrent = inDay(events, current);
  const superseded = new Set(events.flatMap((event) => event.supersedes));
  return inCurrent.filter((event) => event.payload.inventory === mode && !superseded.has(event.id));
}

export function confirmInventory(ledger: Ledger, recordingId: string, transcript: string, items: InventoryItem[], mode: InventoryMode, replace = false) {
  const events = ledger.store.all();
  const superseded = new Set(events.flatMap((event) => event.supersedes));
  const duplicates = events.filter((event) => event.payload.recording_id === recordingId && !superseded.has(event.id));
  if (duplicates.length) return { duplicate: true, events: duplicates, replaced: [] as string[] };

  if (items.some((item) => (item.qty !== null && (!Number.isFinite(item.qty) || item.qty < 0))
    || (item.total_cost !== null && (!Number.isFinite(item.total_cost) || item.total_cost < 0)))) {
    throw new InventoryNeedsAnswers('quantity and cost must be valid non-negative numbers');
  }
  const checked = items.map((item) => updateInventoryItem(item, {}, mode));
  const unanswered = checked.filter((item) => item.question || !item.item.trim());
  if (!checked.length) throw new InventoryNeedsAnswers('no stock items were found; enter or read at least one item');
  if (unanswered.length) throw new InventoryNeedsAnswers(`answer these before saving: ${unanswered.map((item) => item.question ?? item.item).join('; ')}`);

  const itemNames = new Set(checked.map((item) => item.item));
  const clashes = todayInventory(events, mode).filter((event) => itemNames.has(String(event.payload.item)));
  if (clashes.length && !replace) throw new InventoryWouldOverwrite(clashes);

  const created: Event[] = [];
  for (const item of checked) {
    const replaced = clashes.filter((event) => event.payload.item === item.item).map((event) => event.id);
    const common = { recording_id: recordingId, inventory: mode, said: item.said };
    if (mode === 'closing') {
      created.push(ledger.store.appendLocal('stock_count', 'manual', [], {
        payload: { item: item.item, qty: item.qty, unit: item.unit, closing: true, flags: item.flags, ...common },
        confidence: 1, raw: transcript, supersedes: replaced,
      }));
      continue;
    }
    const candidate: CandidateEvent = {
      kind: item.status === 'opening' ? 'opening_stock' : 'purchase',
      source: 'manual',
      confidence: 1,
      item: item.item,
      qty: item.qty,
      unit: item.unit,
      amount_rupees: item.total_cost,
      flags: [...item.flags],
      raw: transcript,
    };
    if (candidate.kind === 'purchase' && candidate.amount_rupees == null) {
      candidate.kind = 'order';
      candidate.flags = [...(candidate.flags ?? []), 'no_amount'];
    }
    created.push(ledger.store.appendLocal(candidate.kind, candidate.source, postingsFor(candidate), {
      payload: {
        item: candidate.item ?? null,
        qty: candidate.qty ?? null,
        unit: candidate.unit ?? null,
        amount_rupees: candidate.amount_rupees ?? null,
        party: null,
        direction: null,
        flags: candidate.flags ?? [],
        unit_cost: item.unit_cost,
        ...common,
      },
      confidence: 1,
      raw: transcript,
      supersedes: replaced,
    }));
  }
  return { duplicate: false, events: created, replaced: clashes.map((event) => event.id) };
}
