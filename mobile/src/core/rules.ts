// Deterministic, lexicon-driven parser: runs with no model at all. Ported from perception/rules.py.
//
// "Bhai 3 kilo tamatar liya 180 mein... Sharma ji ka 40 jama kar, aur 7 plate poha de."
//   -> purchase tomato 3 kg Rs180 | credit_paid sharma Rs40 | sale poha 7 plate (priced from list, flagged)
// Rules, in order of trust:
// - A number word ("do", "saat") is a number only next to a unit, item, money word or "sau"/"hazaar".
// - Numbers followed by a time word ("2 baje") are times, not money.
// - A number right before a unit or an item is a quantity; the rest are money candidates. With more than
//   one candidate and no marker ("mein", "Rs", "ka") singling one out, the amount is left unknown.
// - A clause without a verb takes the previous clause's verb; with none it is returned as unparsed.
// - "X ko 50 diya" (money handed to a person, no item) is an unclassified outflow, not a sale.
import type { CandidateEvent, Kind, Source } from './events';
import type { LexiconData } from './lexicon';

const CLAUSE_SPLIT = /[,.;!?…|\n]+|\s+aur\s+|\s+and\s+|\s+phir\s+/;
const MONEY_AFTER = new Set(['mein', 'me', 'main', 'rupay', 'rupaye', 'rupee', 'rupees', 'rs', 'ka', 'ke', 'ki']);
const MONEY_BEFORE = new Set(['rs', '₹', 'inr', 'ka', 'ke', 'ki']);
const TIME_WORDS = new Set(['baje', 'bje', 'bajkar', 'minute', 'min', 'mins', 'ghanta', 'ghante', 'din', 'tarikh', 'tareekh', 'saal', 'am', 'pm', "o'clock"]);
export const MULTIPLIERS: Record<string, number> = { sau: 100, hazaar: 1000, hazar: 1000 };
const HONORIFIC = '(?:\\s+(?:ji|bhai|uncle|aunty|didi|bhaiya))?';
const SAY_AFTER = new Set(['mein', 'me', 'main', 'rupay', 'rupaye', 'rupee', 'rupees', 'rs']);

// Confidence of a rule-parsed event. Not calibrated: ordering only (heard > inferred > guessed).
export const CONF_HEARD = 0.75;
export const CONF_VERB_INHERITED = 0.6;
export const CONF_PRICED_FROM_LIST = 0.5;
export const CONF_NO_AMOUNT = 0.4;
export const CONF_NO_PARTY = 0.35;
export const CONF_AMBIGUOUS = 0.3;

export type ParseResult = { events: CandidateEvent[]; unparsed: string[] };

const NUM_RE = /^\d+(?:\.\d+)?$/;
const NOT_WORD = new Set([...'₹…“”‘’–—']);
/** Python's \w is Unicode-aware; this matches it for Latin text and treats other scripts' letters as word chars. */
function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  if (/[A-Za-z0-9_]/.test(ch)) return true;
  return ch.charCodeAt(0) >= 0x80 && !/\s/.test(ch) && !NOT_WORD.has(ch);
}

/** The longest phrase from `phrases` that occurs in text as whole words. */
export function phraseFind(text: string, phrases: Iterable<string>): string | null {
  for (const p of [...phrases].sort((a, b) => b.length - a.length)) {
    if (!p) continue;
    let from = 0;
    for (;;) {
      const i = text.indexOf(p, from);
      if (i < 0) break;
      if (!isWordChar(text[i - 1]) && !isWordChar(text[i + p.length])) return p;
      from = i + 1;
    }
  }
  return null;
}

function tokens(clause: string): string[] {
  return clause.match(/₹|[a-z']+|\d+(?:\.\d+)?|[\w.]+/g) ?? [];
}

/** Python's f"{x:g}" for the values spoken numbers produce. */
function fmtG(x: number): string {
  return Number.isInteger(x) ? String(x) : String(Number(x.toPrecision(6)));
}

const strip = (w: string) => w.toLowerCase().replace(/^[.,;!?()]+|[.,;!?()]+$/g, '');

/** "soo gram mirchi" -> "100 gram mirchi", "ek sau assi mein" -> "180 mein": only before a unit/money word. */
export function spokenNumbers(text: string, lex: LexiconData): string {
  const numbers = lex.numbers ?? {};
  const numwords: Record<string, number> = {};
  for (const [k, v] of Object.entries(numbers)) if (!k.includes(' ')) numwords[k] = Number(v);
  const mult: Record<string, number> = { ...MULTIPLIERS };
  for (const [k, v] of Object.entries(numbers)) if ((v === 100 || v === 1000) && !k.includes(' ')) mult[k] = Number(v);
  const units = new Set([...Object.keys(lex.units ?? {}).map((k) => k.split(' ')[0]), ...SAY_AFTER]);
  const toks = [...text.matchAll(/\S+/g)].map((m) => ({ s: m.index as number, e: (m.index as number) + m[0].length, w: strip(m[0]) }));
  const spans: [number, number, string][] = [];
  let i = 0;
  while (i < toks.length) {
    let j = i;
    let val = 0;
    let cur: number | null = null;
    while (j < toks.length) {
      const w = toks[j].w;
      if (w in mult && cur !== null) cur *= mult[w];
      else if (w in numwords && (cur === null || cur >= 100)) {
        val += cur ?? 0;
        cur = numwords[w];
      } else break;
      j++;
    }
    if (cur !== null && j < toks.length && units.has(toks[j].w)) {
      spans.push([toks[i].s, toks[j - 1].e, fmtG(val + cur)]);
      i = j;
    } else i++;
  }
  let out = '';
  let pos = 0;
  for (const [s, e, digits] of spans) {
    out += text.slice(pos, s) + digits;
    pos = e;
  }
  return out + text.slice(pos);
}

/** Every number literally present in text (digits, number words, "do sau"), for cross-checking. */
export function numbersIn(text: string, numwords: Record<string, number>): Set<number> {
  const out = new Set<number>();
  const toks = tokens(text.toLowerCase().replace(/,/g, ''));
  toks.forEach((t, i) => {
    if (NUM_RE.test(t)) out.add(Number(t));
    else if (t in numwords) {
      const v = Number(numwords[t]);
      out.add(v);
      if (i + 1 < toks.length && toks[i + 1] in MULTIPLIERS) out.add(v * MULTIPLIERS[toks[i + 1]]);
    } else if (t in MULTIPLIERS) out.add(MULTIPLIERS[t]);
  });
  return out;
}

function numbersOf(toks: string[], numwords: Record<string, number>, context: Set<string>): [number, number][] {
  const out: [number, number][] = [];
  const skip = new Set<number>();
  toks.forEach((t, i) => {
    if (skip.has(i)) return;
    let nxt = toks[i + 1] ?? '';
    let val: number;
    if (NUM_RE.test(t)) val = Number(t);
    else if (t in numwords && (context.has(nxt) || MONEY_AFTER.has(nxt) || nxt in MULTIPLIERS)) val = Number(numwords[t]);
    else return;
    if (nxt in MULTIPLIERS) {
      val *= MULTIPLIERS[nxt];
      skip.add(i + 1);
      nxt = toks[i + 2] ?? '';
    }
    if (TIME_WORDS.has(nxt)) return;
    out.push([i, val]);
  });
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** (party, is_recipient). Recipient = "X ko ..." (something handed to X). */
function partyOf(clause: string, aliases: Record<string, string>, notPeople: Set<string>): [string | null, boolean] {
  const alias = phraseFind(clause, Object.keys(aliases));
  const mTo = clause.match(new RegExp(`(\\w+)${HONORIFIC}\\s+ko\\b`));
  if (alias) return [aliases[alias], new RegExp(`${escape(alias)}\\s+ko\\b`).test(clause)];
  const m = clause.match(new RegExp(`(\\w+)${HONORIFIC}\\s+(?:ka|ki|ke|se)\\b`));
  const person = (w: string) => !notPeople.has(w) && !(w in MULTIPLIERS) && !/^\d/.test(w); // "gas ka", "40 ka"
  if (m && person(m[1])) return [m[1], false];
  if (mTo && person(mTo[1])) return [mTo[1], true];
  return [null, false];
}

export function parseDetailed(text: string, lex: LexiconData, source: Source = 'manual'): ParseResult {
  const items = lex.items ?? {};
  const itemWords: Record<string, string> = { ...items };
  for (const v of Object.values(items)) itemWords[v] = v;
  const units = lex.units ?? {};
  const aliases = lex.aliases ?? {};
  const verbs = lex.verbs ?? {};
  const numwords = (lex.numbers ?? {}) as Record<string, number>;
  const prices = lex.prices ?? {};
  const context = new Set([...Object.keys(units).map((u) => u.split(' ')[0]), ...Object.keys(itemWords).map((w) => w.split(' ')[0])]);
  const notPeople = new Set([...Object.keys(itemWords), ...Object.keys(units), ...Object.keys(verbs), ...Object.keys(numwords)]);

  const result: ParseResult = { events: [], unparsed: [] };
  let lastKind: Kind | null = null;
  for (const raw of text.toLowerCase().split(CLAUSE_SPLIT)) {
    const clause = raw.trim();
    if (!clause) continue;
    const toks = tokens(clause);
    const verb = phraseFind(clause, Object.keys(verbs));
    const itemKey = phraseFind(clause, Object.keys(itemWords));
    const unitKey = phraseFind(clause, Object.keys(units));
    const [partyName, recipient] = partyOf(clause, aliases, notPeople);
    const nums = numbersOf(toks, numwords, context);
    if (!verb && !nums.length) continue; // chatter, not a transaction

    let flags: string[] = [];
    let kind: Kind | null = verb ? (verbs[verb] as Kind) : null;
    if (kind === null && lastKind !== null && nums.length) {
      kind = lastKind;
      flags = ['verb_inherited'];
    }
    if (kind === null) {
      result.unparsed.push(clause);
      continue;
    }
    lastKind = kind;

    let qty: number | null = null;
    let unit: string | null = null;
    const unitFirst = unitKey ? unitKey.split(' ')[0] : null;
    const itemFirst = itemKey ? itemKey.split(' ')[0] : null;
    const money: [number, number][] = [];
    for (const [idx, val] of nums) {
      let nxt = toks[idx + 1] ?? '';
      if (nxt in MULTIPLIERS) nxt = toks[idx + 2] ?? '';
      if (qty === null && unitFirst && nxt === unitFirst) {
        qty = val * units[unitKey as string].factor;
        unit = units[unitKey as string].unit;
      } else if (qty === null && !unitFirst && itemFirst && nxt === itemFirst) qty = val;
      else money.push([idx, val]);
    }
    if (qty === null && unitKey && unitKey.includes(' ')) {
      // "aadha kilo" carries its own number
      qty = units[unitKey].factor;
      unit = units[unitKey].unit;
    }

    let amount: number | null = null;
    if (money.length === 1) amount = money[0][1];
    else if (money.length > 1) {
      const marked = (i: number) => MONEY_BEFORE.has(toks[i - 1] ?? '') || MONEY_AFTER.has(toks[i + 1] ?? '');
      const picks = money.filter(([i]) => marked(i)).map(([, v]) => v);
      if (picks.length === 1) amount = picks[0];
      else flags.push('ambiguous_amount');
    }

    const item = itemKey ? itemWords[itemKey] : null;
    let direction: 'in' | 'out' | null = null;
    if (kind === 'sale' && recipient && item === null) {
      kind = 'adjustment'; // "sharma ji ko 50 diya": money out, purpose unknown
      direction = 'out';
      flags.push('unclassified_outflow');
    }

    let confidence = flags.includes('verb_inherited') ? CONF_VERB_INHERITED : CONF_HEARD;
    if (kind === 'sale' && amount === null && item !== null && item in prices && qty && !flags.includes('ambiguous_amount')) {
      amount = qty * Number(prices[item]);
      confidence = Math.min(confidence, CONF_PRICED_FROM_LIST);
      flags.push('priced_from_list');
    }
    if (amount === null && kind !== 'stock_count' && kind !== 'order') confidence = Math.min(confidence, CONF_NO_AMOUNT);
    if (flags.includes('ambiguous_amount')) confidence = CONF_AMBIGUOUS;
    if ((kind === 'credit_paid' || kind === 'credit_given') && !partyName) {
      confidence = Math.min(confidence, CONF_NO_PARTY);
      flags.push('no_party');
    }
    result.events.push({ kind, source, confidence, item, qty, unit, amount_rupees: amount, party: partyName, direction, flags, raw: clause });
  }
  return result;
}

export const parse = (text: string, lex: LexiconData, source: Source = 'manual') => parseDetailed(text, lex, source).events;
