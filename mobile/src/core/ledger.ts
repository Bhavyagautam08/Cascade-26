// One path from evidence to ledger, shared by every screen and the always-on mic. Ported from
// backend/app/pipeline.py (and main.py's ledger summary).
//
// text --(bank SMS parser | local language model + cross-check | rule parser)--> candidate events
//      --> balanced postings --> event log
// Failures are classified, never blurred: ModelUnavailable / ModelOutputInvalid fall back to the rule
// parser and say why (fallbackReason); anything else is a bug and is thrown.
import { currentDay, inDay, listDays, startDay } from './days';
import { balances, incomplete, postingsFor, trialBalanceOk } from './doubleentry';
import type { CandidateEvent, Event, Source } from './events';
import { amountOf, fuse } from './fusion';
import { dayProfit, receivables } from './inference';
import type { Lexicon } from './lexicon';
import { CONF_NO_AMOUNT, CONF_PRICED_FROM_LIST, numbersIn, parse, parseDetailed, spokenNumbers } from './rules';
import { parseSms, type BankTxn } from './sms';
import type { EventStore } from './store';

export class ModelUnavailable extends Error {}
export class ModelOutputInvalid extends Error {}
export class NotFound extends Error {}
export class NotTheSameTrade extends Error {}

export interface Extractor {
  name: string;
  fromText(text: string, source: Source): Promise<{ is_transaction: boolean; events: CandidateEvent[] }>;
}

export type Settings = {
  llmMaxConfidence: number; // the model's self-reported confidence is uncalibrated: cap it
  voiceRepeatWindowS: number; // the same trade heard again within this many seconds is booked once
  voiceMinClarity: number; // heard less clearly than this: shown, not booked until the vendor says so
};
export const DEFAULT_SETTINGS: Settings = { llmMaxConfidence: 0.85, voiceRepeatWindowS: 60, voiceMinClarity: 0.25 };

export type Heard = { text: string; confidence: number; via: string; engine: string | null; events: number; held: string | null; repeats: number };

const fmtG = (x: number) => (Number.isInteger(x) ? String(x) : String(Number(x.toPrecision(6))));

/** Team rule: every trade is recorded. A purchase without an amount is kept as an order (books nothing). */
export function asRecorded(c: CandidateEvent): CandidateEvent {
  if (c.kind === 'purchase' && c.amount_rupees == null && !(c.flags ?? []).includes('amount_unreadable')) {
    return { ...c, kind: 'order', flags: [...(c.flags ?? []), 'no_amount'] };
  }
  return c;
}

/** The payload Python stores: the candidate minus kind, source, raw and confidence, every field present. */
function payloadOf(c: CandidateEvent) {
  return {
    item: c.item ?? null,
    qty: c.qty ?? null,
    unit: c.unit ?? null,
    amount_rupees: c.amount_rupees ?? null,
    party: c.party ?? null,
    direction: c.direction ?? null,
    flags: c.flags ?? [],
  };
}

const signature = (c: CandidateEvent) => {
  const r = asRecorded(c);
  return JSON.stringify([r.kind, r.item ?? null, r.qty == null ? null : Math.round(r.qty * 1000) / 1000, r.unit ?? null, r.amount_rupees ?? null, (r.party ?? '').toLowerCase() || null]);
};

export class Ledger {
  extractor: Extractor | null = null;
  recentHeard: Heard[] = []; // last few utterances, text only, never audio
  private recentVoice: [number, string, string][] = []; // (mono time, trade signature, event id)

  constructor(readonly store: EventStore, readonly lexicon: Lexicon, readonly settings: Settings = DEFAULT_SETTINGS) {}

  // --- recording ---------------------------------------------------------------------------------
  record(cands: CandidateEvent[], supersedes: string[] = []): Event[] {
    return cands.map(asRecorded).map((c) =>
      this.store.appendLocal(c.kind, c.source, postingsFor(c), { payload: payloadOf(c), confidence: c.confidence, raw: c.raw ?? null, supersedes }),
    );
  }

  private fromBankSms(txn: BankTxn, source: Source, text: string): CandidateEvent {
    const aliases = this.lexicon.data.aliases ?? {};
    const party = txn.party ? aliases[txn.party] ?? txn.party : null;
    const owed = party ? balances(fuse(this.store.all()).effective)[`receivable:${party}`] ?? 0 : 0;
    if (txn.direction === 'in' && owed > 0) {
      return { kind: 'credit_paid', source, confidence: 0.9, party, amount_rupees: txn.amount_rupees, flags: ['bank_sms'], raw: text };
    }
    const flag = txn.direction === 'in' ? 'unclassified_inflow' : 'unclassified_outflow';
    return { kind: 'adjustment', source, confidence: 0.95, party, amount_rupees: txn.amount_rupees, direction: txn.direction, flags: ['bank_sms', flag], raw: text };
  }

  /** Hold the model to the words said: an amount not in the text (and not qty x list price) is removed. */
  crossCheck(text: string, cands: CandidateEvent[]) {
    const said = numbersIn(text, (this.lexicon.data.numbers ?? {}) as Record<string, number>);
    const prices = this.lexicon.data.prices ?? {};
    let removed = 0;
    for (const c of cands) {
      c.flags = c.flags ?? [];
      c.confidence = Math.min(c.confidence, this.settings.llmMaxConfidence);
      if (c.amount_rupees == null) continue;
      const priced = !!c.qty && !!c.item && c.item in prices && Math.abs(c.qty * Number(prices[c.item]) - c.amount_rupees) < 0.01;
      if (!said.has(c.amount_rupees) && !priced) {
        c.flags.push(`amount_not_in_text:${fmtG(c.amount_rupees)}`);
        c.amount_rupees = null;
        c.confidence = Math.min(c.confidence, CONF_NO_AMOUNT);
        removed++;
      } else if (priced && !said.has(c.amount_rupees)) {
        c.flags.push('priced_from_list');
        c.confidence = Math.min(c.confidence, CONF_PRICED_FROM_LIST);
      }
    }
    const byRules = parse(text, this.lexicon.data);
    const key = (cs: CandidateEvent[]) => JSON.stringify(cs.map((c) => [c.kind, c.amount_rupees || 0]).sort());
    return { rules_events: byRules.length, llm_events: cands.length, agree: key(byRules) === key(cands), amounts_removed: removed };
  }

  private dropRepeats(cands: CandidateEvent[]) {
    const now = this.store.clocks.mono();
    const recent = new Map<string, [number, string]>();
    for (const [t, sig, id] of this.recentVoice) if (now - t <= this.settings.voiceRepeatWindowS) recent.set(sig, [t, id]);
    const keep: CandidateEvent[] = [];
    const repeats: { of: string; seconds_ago: number; what: string }[] = [];
    for (const c of cands) {
      const hit = recent.get(signature(c));
      if (hit) repeats.push({ of: hit[1], seconds_ago: Math.round((now - hit[0]) * 10) / 10, what: (JSON.parse(signature(c)) as unknown[]).filter((x) => x != null).join(' ') });
      else keep.push(c);
    }
    return { keep, repeats };
  }

  /** engine: auto (model, else rules if the model is unavailable / off-schema) | llm | rules */
  async handleText(text: string, source: Source, opts: { engine?: 'auto' | 'llm' | 'rules'; heardConfidence?: number; extraFlags?: string[]; dropRepeats?: boolean } = {}) {
    const { engine = 'auto', heardConfidence = 1, extraFlags = [], dropRepeats = false } = opts;
    const result: { engine: string; is_transaction: boolean; events: Event[]; unparsed: string[]; fallback_reason: string | null; cross_check: unknown; normalized_text?: string; repeats?: unknown[] } = {
      engine: 'rules', is_transaction: false, events: [], unparsed: [], fallback_reason: null, cross_check: null,
    };
    let cands: CandidateEvent[] | null = null;
    const txn = parseSms(text);
    const said = txn ? text : spokenNumbers(text, this.lexicon.data); // "soo gram" -> "100 gram"
    if (said !== text) result.normalized_text = said;
    if (txn) {
      cands = [this.fromBankSms(txn, source, text)];
      result.engine = 'bank_sms';
    } else if (engine !== 'rules') {
      try {
        if (!this.extractor) throw new ModelUnavailable('the language model is not loaded on this phone');
        const out = await this.extractor.fromText(said, source);
        cands = out.events;
        result.engine = this.extractor.name;
        result.cross_check = this.crossCheck(said, cands);
      } catch (e) {
        if (!(e instanceof ModelUnavailable || e instanceof ModelOutputInvalid) || engine === 'llm') throw e;
        result.fallback_reason = e.message;
      }
    }
    if (cands === null) {
      const parsed = parseDetailed(said, this.lexicon.data, source);
      cands = parsed.events;
      result.unparsed = parsed.unparsed;
    }
    for (const c of cands) {
      c.confidence = Math.round(c.confidence * heardConfidence * 1000) / 1000;
      c.flags = [...(c.flags ?? []), ...extraFlags];
    }
    result.is_transaction = cands.length > 0;
    if (dropRepeats) {
      const { keep, repeats } = this.dropRepeats(cands);
      cands = keep;
      result.repeats = repeats;
    }
    result.events = this.record(cands);
    if (dropRepeats) {
      const now = this.store.clocks.mono();
      cands.forEach((c, i) => this.recentVoice.push([now, signature(c), result.events[i].id]));
      this.recentVoice = this.recentVoice.slice(-200);
    }
    return result;
  }

  /** A transcript from any voice path -> ledger + the "heard" feed (too unclear: shown, not booked). */
  async heard(text: string, confidence: number, via: string, source: Source = 'voice') {
    const flags = via === 'simulated' ? ['simulated_voice'] : [];
    let result: Awaited<ReturnType<Ledger['handleText']>> | { engine: null; is_transaction: false; events: Event[]; held: string };
    if (confidence < this.settings.voiceMinClarity) result = { engine: null, is_transaction: false, events: [], held: 'too unclear to book' };
    else result = await this.handleText(text, source, { heardConfidence: confidence, extraFlags: flags, dropRepeats: true });
    this.recentHeard = [
      ...this.recentHeard,
      { text, confidence: Math.round(confidence * 100) / 100, via, engine: result.engine, events: result.events.length, held: 'held' in result ? result.held : null, repeats: 'repeats' in result ? (result.repeats ?? []).length : 0 },
    ].slice(-20);
    return result;
  }

  // --- human decisions: stored as new events -----------------------------------------------------
  private byId(id: string): Event {
    const e = this.store.get(id);
    if (!e) throw new NotFound(`no entry ${id}`);
    return e;
  }

  /** Settle a dispute: one vendor-confirmed entry replaces the disputed claims. */
  resolve(ids: string[], amountRupees: number): Event[] {
    const key = [...ids].sort().join();
    const conflict = fuse(this.store.all()).conflicts.find((c) => [...c.ids].sort().join() === key);
    if (!conflict) throw new NotFound('no open dispute with these entries');
    const claims = conflict.ids.map((i) => this.byId(i));
    const chosen = claims.find((e) => amountOf(e) === Math.round(amountRupees * 100)) ?? claims.reduce((a, b) => (amountOf(b) < amountOf(a) ? b : a));
    const [lo, hi] = conflict.claims_paise.map((p) => fmtG(p / 100));
    return this.record(
      [{ kind: chosen.kind, source: 'manual', confidence: 1, party: conflict.party, item: (chosen.payload.item as string) ?? null, qty: (chosen.payload.qty as number) ?? null, unit: (chosen.payload.unit as string) ?? null, amount_rupees: amountRupees, raw: `settled dispute: Rs${lo} vs Rs${hi} -> Rs${fmtG(amountRupees)}` }],
      [...ids].sort(),
    );
  }

  /** Withdraw a wrong entry. The original stays in the log; it just stops counting. */
  void(id: string): Event {
    this.byId(id);
    return this.store.appendLocal('adjustment', 'manual', [], { payload: { voided: id }, raw: `void ${id}`, supersedes: [id] });
  }

  /** The vendor's version replaces the original with full confidence. Only the fields given change. */
  correct(id: string, changes: Partial<Pick<CandidateEvent, 'kind' | 'item' | 'qty' | 'unit' | 'amount_rupees' | 'party' | 'direction'>>): Event[] {
    const old = this.byId(id);
    const fields = { item: old.payload.item ?? null, qty: old.payload.qty ?? null, unit: old.payload.unit ?? null, amount_rupees: old.payload.amount_rupees ?? null, party: old.payload.party ?? null, direction: old.payload.direction ?? null, ...changes } as Record<string, unknown>;
    const kind = changes.kind ?? old.kind;
    if (kind !== 'adjustment') fields.direction = null;
    delete fields.kind;
    return this.record([{ kind, source: 'manual', confidence: 1, flags: ['corrected'], raw: `correction of ${id}`, ...(fields as Partial<CandidateEvent>) }], [id]);
  }

  /** "These are different trades." */
  separate(ids: string[]): Event {
    ids.forEach((i) => this.byId(i));
    return this.store.appendLocal('adjustment', 'manual', [], { payload: { separate: [...ids].sort() }, raw: `separate trades: ${ids.join(', ')}` });
  }

  /** "These are one trade" (e.g. two phones out of touch). Only for the same kind, customer and amount. */
  same(ids: string[]): Event {
    const evs = ids.map((i) => this.byId(i));
    const looks = new Set(evs.map((e) => JSON.stringify([e.kind, String(e.payload.party ?? '').toLowerCase() || null, amountOf(e)])));
    if (looks.size > 1) {
      throw new NotTheSameTrade(`these entries differ, so they can't be one trade: ${evs.map((e) => `${e.id}: ${e.kind} Rs${fmtG(amountOf(e) / 100)}${e.payload.party ? ` for ${e.payload.party}` : ''}`).join('; ')}`);
    }
    return this.store.appendLocal('adjustment', 'manual', [], { payload: { same: [...ids].sort() }, raw: `one trade: ${ids.join(', ')}` });
  }

  newDay(): Event {
    this.recentHeard = [];
    this.recentVoice = [];
    return startDay(this.store);
  }

  // --- reading -------------------------------------------------------------------------------------
  /** One business day's profit and lists; balances, udhaar and disputes are cumulative (main.py summary). */
  summary(day?: number) {
    const events = this.store.all();
    const report = fuse(events);
    const known = new Map(listDays(events).map((d) => [d.index, d]));
    const current = currentDay(events);
    const index = day ?? current;
    const d = known.get(index);
    if (!d) throw new NotFound(`no business day ${index}; days are ${[...known.keys()].join(', ')}`);
    return {
      day: { ...d, current: index === current },
      balanced: trialBalanceOk(report.effective),
      balances_paise: balances(report.effective),
      receivables: receivables(report.effective),
      profit: dayProfit(report.effective, index),
      duplicates: report.duplicates,
      conflicts: report.conflicts,
      possible_conflicts: report.possible_conflicts,
      possible_duplicates: report.possible_duplicates,
      incomplete: incomplete(inDay(events, index)),
      frontier: this.store.frontier(),
    };
  }
}
