// Pieces several screens share, ported from the dashboard (frontend/src/derive.ts, Dispute.tsx, Books.tsx).
import React, { createContext, useContext, useEffect, useState } from 'react';
import { Alert, Linking, Text, TextInput, View } from 'react-native';
import { clipRecorder, listener, MicBlocked } from '../app/mic';
import { service } from '../app/service';
import type { Event, Kind, Source } from '../core/events';
import type { Conflict, FusionReport } from '../core/fusion';
import { nameOf } from '../core/identity';
import { closestItem, itemLabel } from '../core/spelling';
import { Actions, Button, C, Card, Conf, ErrorLine, Field, Input, KindTag, LevelMeter, MicButton, Muted, Pill, Row, Segmented, StatusDot, cap, fmtQty, inr, paise, s } from './kit';
import { t } from './strings';

export const ledger = () => service.ledger!;

// --- navigation: a tab plus a stack of pages (Android back pops the stack) -----------------------------
export type Page = { name: 'entries' } | { name: 'entry'; id: string; edit?: boolean } | { name: 'books' } | { name: 'words' } | { name: 'family' } | { name: 'diagnose' } | { name: 'party'; party: string };
export const Nav = createContext<{ push: (p: Page) => void; pop: () => void; tab: (name: string) => void }>({ push: () => {}, pop: () => {}, tab: () => {} });
export const useNav = () => useContext(Nav);

// --- words for an entry ----------------------------------------------------------------------------------
/** The vendor's word for a ledger item ("tomato" -> "tamatar"). */
export const itemName = (item: unknown) => (item ? itemLabel(String(item), ledger().lexicon.data) : '');

/** What kind of entry this is, in words; an "adjustment" says what it actually did. */
export function kindText(e: Pick<Event, 'kind' | 'payload'>): string {
  if (e.kind !== 'adjustment') return t.kinds[e.kind] ?? e.kind;
  const p = e.payload as Record<string, any>;
  if (p.voided) return t.changes.voided;
  if (p.same) return t.changes.same;
  if (p.separate) return t.changes.separate;
  if (p.direction === 'in') return t.changes.bankIn;
  if (p.direction === 'out') return t.changes.bankOut;
  return t.changes.other;
}

export function what(e: Event): string {
  const p = e.payload as Record<string, any>;
  if (p.voided) {
    const gone = ledger().store.get(p.voided);
    return gone ? `${kindText(gone)}: ${what(gone)}` : '1 entry';
  }
  if (p.same || p.separate) return `${(p.same ?? p.separate).length} entries`;
  const qty = p.qty != null ? `${fmtQty(p.qty)} ${p.unit ?? ''}`.trim() : null;
  return [qty, itemName(p.item), p.party && cap(p.party)].filter(Boolean).join(' · ') || '—';
}
export const grossPaise = (e: Event) => e.postings.reduce((x, p) => x + Math.max(p.amount, 0), 0);
export function amountText(e: Event) {
  const p = grossPaise(e);
  if (p) return paise(p);
  return e.kind === 'adjustment' || e.kind === 'day_start' || e.kind === 'stock_count' || e.kind === 'opening_stock' ? '—' : 'daam nahi';
}
export const isUdhaar = (k: string) => k === 'credit_given' || k === 'credit_paid';

/** "Sharma ka jama", "poha becha". */
export function subject(c: { kind: string; party: string | null; item: unknown }) {
  if (isUdhaar(c.kind) && c.party) return `${cap(c.party)} ka ${c.kind === 'credit_paid' ? 'jama' : 'udhaar'}`;
  return `${c.item ? `${itemName(c.item)} ` : ''}${(t.kinds[c.kind] ?? c.kind).toLowerCase()}`;
}

/** Wall clocks are untrusted: a phone at 1970 (or 2099) is marked, never used for ordering. */
export function wallClock(ts: number | null) {
  if (ts == null) return { text: '—', bad: false };
  const d = new Date(ts * 1000);
  const y = d.getFullYear();
  const bad = y < 2000 || y > 2090;
  const p = (n: number) => String(n).padStart(2, '0');
  return { text: `${y}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`, bad };
}

/** How each entry stands in the fused view: replaced, counted once with others, disputed, maybe twice. */
export function standing(events: Event[], rep: FusionReport) {
  const superseded = new Map<string, 'voided' | 'settled'>();
  for (const e of events) for (const sid of e.supersedes) superseded.set(sid, e.kind === 'adjustment' ? 'voided' : 'settled');
  const fusedWith = new Map<string, string[]>();
  for (const g of rep.duplicates) for (const id of g) fusedWith.set(id, g);
  const disputed = new Set(rep.conflicts.flatMap((c) => c.ids));
  const maybeTwice = new Set(rep.possible_duplicates.flatMap((d) => d.ids));
  return { superseded, fusedWith, disputed, maybeTwice };
}

export function tryRun(fn: () => void, setError: (e: string | null) => void) {
  try {
    fn();
    setError(null);
  } catch (e) {
    setError((e as Error).message);
  }
}

// --- rows and cards ------------------------------------------------------------------------------------------
export function EntryRow({ e, gone, onPress, marks }: { e: Event; gone?: string; onPress?: () => void; marks?: React.ReactNode }) {
  return (
    <Row onPress={onPress} style={gone ? { opacity: 0.5 } : undefined}>
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <KindTag kind={e.kind} label={kindText(e)} />
          {gone ? <Pill tone="muted">{t.entries.gone[gone]}</Pill> : null}
          {marks}
        </View>
        <Text style={[s.body, { fontWeight: '600' }]}>{what(e)}</Text>
        {e.raw ? <Text style={s.small} numberOfLines={2}>“{e.raw}” · {nameOf(e.device_id)}</Text> : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Text style={[s.body, { fontWeight: '800' }]}>{amountText(e)}</Text>
        {e.kind !== 'day_start' && e.kind !== 'adjustment' ? <Conf value={e.confidence} /> : null}
      </View>
    </Row>
  );
}

/** One trade heard with two amounts. The lower is booked until the vendor says which it was. */
export function Dispute({ c }: { c: Conflict }) {
  const [other, setOther] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lo, hi] = c.claims_paise.map((x) => x / 100);
  const phones = c.ids.map((id) => nameOf(id.split(':')[0]));
  return (
    <Card tone="warn">
      <Text style={[s.body, { fontWeight: '700' }]}>{t.today.settle(subject(c))}</Text>
      <Muted>
        {t.dispute.phones(phones[0], phones[1])} · {t.dispute.booked(inr(lo))}
        {c.suspense_paise ? ` · ${t.dispute.waiting(paise(c.suspense_paise))}` : ''}
      </Muted>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}><Button small label={t.dispute.itWas(inr(lo))} onPress={() => tryRun(() => ledger().resolve(c.ids, lo), setError)} /></View>
        <View style={{ flex: 1 }}><Button small label={t.dispute.itWas(inr(hi))} onPress={() => tryRun(() => ledger().resolve(c.ids, hi), setError)} /></View>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <TextInput style={[s.input, { flex: 1 }]} keyboardType="numeric" placeholder={t.dispute.other} placeholderTextColor={C.faint} value={other} onChangeText={setOther} accessibilityLabel={t.dispute.other} />
        <Button small kind="plain" label={t.dispute.set} disabled={!other.trim() || isNaN(Number(other))} onPress={() => tryRun(() => ledger().resolve(c.ids, Number(other)), setError)} />
      </View>
      <ErrorLine error={error} />
    </Card>
  );
}

export function MaybeTwice({ d, byId }: { d: FusionReport['possible_duplicates'][number]; byId: Map<string, Event> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Card tone="warn">
      <Text style={[s.body, { fontWeight: '700' }]}>{t.today.twice(`${subject(d)} ${paise(d.amount_paise)}`)}</Text>
      {d.ids.map((id) => (
        <Muted key={id}>{nameOf(id.split(':')[0])}: “{byId.get(id)?.raw ?? id}”</Muted>
      ))}
      <Muted>{t.dispute.whyTwice}</Muted>
      <Button small label={t.dispute.one} onPress={() => tryRun(() => ledger().same(d.ids), setError)} />
      <Button small kind="plain" label={t.dispute.two} onPress={() => tryRun(() => ledger().separate(d.ids), setError)} />
      <ErrorLine error={error} />
    </Card>
  );
}

/** "Hatao" asks first: the entry stops counting (it stays in the history). */
export function confirmRemove(e: Event, setError: (e: string | null) => void, after?: () => void) {
  Alert.alert(t.review.remove, t.review.removeConfirm(`${kindText(e)}: ${what(e)}`), [
    { text: t.today.no, style: 'cancel' },
    { text: t.review.remove, style: 'destructive', onPress: () => tryRun(() => { ledger().void(e.id); after?.(); }, setError) },
  ]);
}

const parseAmount = (x: string, field: string): number | null => {
  if (!x.trim()) return null;
  const n = Number(x.replace(/,/g, '').replace(/^₹/, ''));
  if (!Number.isFinite(n) || n < 0) throw new Error(t.entry.badNumber(field));
  return n;
};

/** One entry that needs the vendor: what was said, what was booked, and ✓ / ✎ / 🗑 right there. */
export function ReviewItem({ e }: { e: Event }) {
  const nav = useNav();
  const [error, setError] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const noPrice = e.postings.length === 0 && ['purchase', 'sale', 'credit_given', 'credit_paid', 'expense', 'order'].includes(e.kind);
  return (
    <View style={{ gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <KindTag kind={e.kind} label={kindText(e)} />
        <Text style={[s.body, { fontWeight: '700', flex: 1 }]}>{what(e)}</Text>
        <Text style={[s.body, { fontWeight: '800' }]}>{noPrice ? t.review.noPrice : amountText(e)}</Text>
      </View>
      {e.raw ? <Text style={s.muted} numberOfLines={3}>{t.review.said(e.raw)}</Text> : null}
      <Conf value={e.confidence} />
      {noPrice ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Input style={{ flex: 1 }} keyboardType="decimal-pad" placeholder={t.review.price} value={price} onChangeText={setPrice} accessibilityLabel={t.review.price} />
          <Button small label={t.review.setPrice} disabled={!price.trim()} onPress={() => tryRun(() => {
            const amount = parseAmount(price, t.review.price);
            ledger().correct(e.id, { amount_rupees: amount, kind: e.kind === 'order' ? 'purchase' : e.kind });
          }, setError)} />
        </View>
      ) : null}
      <Actions>
        {!noPrice ? <Button small icon="✓" label={t.review.ok} onPress={() => tryRun(() => ledger().confirm(e.id), setError)} /> : null}
        <Button small kind="soft" icon="✎" label={t.review.edit} onPress={() => nav.push({ name: 'entry', id: e.id, edit: true })} />
        <Button small kind="plain" icon="🗑" label={t.review.remove} onPress={() => confirmRemove(e, setError)} />
      </Actions>
      <ErrorLine error={error} />
    </View>
  );
}

const STOCK_KINDS: Kind[] = ['opening_stock', 'purchase', 'stock_count', 'order'];
const MONEY_KINDS: Kind[] = ['purchase', 'sale', 'credit_given', 'credit_paid', 'expense', 'order'];

/** "tamatar" -> the ledger's item key ("tomato"); a new word stays as typed. */
export function itemKey(text: string): string | null {
  const w = text.trim().toLowerCase();
  if (!w) return null;
  const lex = ledger().lexicon.data;
  const items = lex.items ?? {};
  if (items[w]) return items[w];
  if (Object.values(items).includes(w)) return w;
  const near = closestItem(w, lex);
  return near ? items[near] ?? near : w;
}

/** Change any field of an entry. The vendor's version replaces the old one (which stays in the history). */
export function EditEntry({ e, onDone }: { e: Event; onDone: (newId: string) => void }) {
  const p = e.payload as Record<string, any>;
  const stock = STOCK_KINDS.includes(e.kind) && e.kind !== 'purchase' ? true : !!p.inventory;
  const kinds = stock ? STOCK_KINDS : MONEY_KINDS;
  const [kind, setKind] = useState<Kind>(e.kind);
  const [item, setItem] = useState(itemName(p.item));
  const [qty, setQty] = useState(p.qty != null ? String(p.qty) : '');
  const [unit, setUnit] = useState(p.unit ?? '');
  const [amount, setAmount] = useState(p.amount_rupees != null ? String(p.amount_rupees) : '');
  const [party, setParty] = useState(p.party ?? '');
  const [error, setError] = useState<string | null>(null);
  const needsParty = kind === 'credit_given' || kind === 'credit_paid';
  const hasMoney = kind !== 'stock_count';

  function save() {
    tryRun(() => {
      const changes = {
        kind,
        item: itemKey(item),
        qty: parseAmount(qty, t.entry.qty),
        unit: unit.trim() || null,
        amount_rupees: hasMoney ? parseAmount(amount, t.entry.amount) : null,
        party: party.trim() ? ledger().partyKey(party) : null,
      };
      if (needsParty && !changes.party) throw new Error(t.udhaar.needName);
      const [n] = ledger().correct(e.id, changes);
      onDone(n.id);
    }, setError);
  }

  return (
    <Card title={t.entry.editTitle} tone="good">
      <Field label={t.entry.kind}>
        <Segmented value={kind} onChange={setKind} options={kinds.map((k) => ({ value: k, label: t.kinds[k] }))} />
      </Field>
      {kind !== 'credit_given' && kind !== 'credit_paid' ? (
        <Field label={t.entry.item}><Input value={item} onChangeText={setItem} autoCapitalize="none" accessibilityLabel={t.entry.item} /></Field>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Field label={t.entry.qty}><Input value={qty} onChangeText={setQty} keyboardType="decimal-pad" accessibilityLabel={t.entry.qty} /></Field>
        <Field label={t.entry.unit}><Input value={unit} onChangeText={setUnit} autoCapitalize="none" accessibilityLabel={t.entry.unit} /></Field>
      </View>
      {hasMoney ? <Field label={t.entry.amount}><Input value={amount} onChangeText={setAmount} keyboardType="decimal-pad" accessibilityLabel={t.entry.amount} /></Field> : null}
      {needsParty || party ? <Field label={t.entry.party}><Input value={party} onChangeText={setParty} accessibilityLabel={t.entry.party} /></Field> : null}
      <Button icon="✓" label={t.entry.save} onPress={save} />
      <ErrorLine error={error} />
    </Card>
  );
}

const ASK_KINDS = ['sale', 'purchase', 'expense', 'credit_given'] as const;

/** "Kya hua tha?" for a sentence with numbers but no trade word: one tap books it as that kind. */
export function AskKind({ text, source, onBooked }: { text: string; source: Source; onBooked: (ids: string[]) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!ledger().mightBeTrade(text)) return null;
  async function pick(kind: (typeof ASK_KINDS)[number]) {
    setBusy(true);
    try {
      const r = await ledger().bookAs(text, kind, source);
      if (!r.events.length) throw new Error(t.ask.nothing);
      setError(null);
      onBooked(r.events.map((e) => e.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 6 }}>
      <Text style={[s.small, { color: C.warn, fontWeight: '700' }]}>{t.ask.question}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {ASK_KINDS.map((k) => <Button key={k} small kind="soft" label={t.kinds[k]} disabled={busy} onPress={() => void pick(k)} style={{ minHeight: 44, paddingHorizontal: 12 }} />)}
      </View>
      <ErrorLine error={error} />
    </View>
  );
}

// --- the always-on mic --------------------------------------------------------------------------------
/** The one-clip recorder's state (active, seconds, level), re-rendered while recording. */
export function useClip() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const off = clipRecorder.subscribe(() => setTick((x) => x + 1));
    const id = setInterval(() => clipRecorder.active && setTick((x) => x + 1), 500); // the seconds keep moving
    return () => {
      off();
      clearInterval(id);
    };
  }, []);
  return { active: clipRecorder.active, seconds: clipRecorder.seconds, level: clipRecorder.level };
}

export function useListen() {
  const [st, setSt] = useState(listener.status);
  useEffect(() => listener.subscribe(() => setSt(listener.status)), []);
  return st;
}

/** Start / stop hearing the day, how loud the room is, and what was just heard and booked. */
export function MicPanel({ compact }: { compact?: boolean }) {
  const st = useListen();
  const nav = useNav();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await service.setListening(!st.on);
      setBlocked(false);
    } catch (e) {
      setBlocked(e instanceof MicBlocked);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const stateText = st.state === 'listening' ? t.mic.on : st.state === 'starting' ? t.mic.starting : st.state === 'error' ? t.mic.error : t.mic.off;
  const heard = [...st.heard].reverse().slice(0, compact ? 3 : 10);
  return (
    <Card title={t.mic.title} aside={<StatusDot on={st.on} text={stateText} tone={st.state === 'error' ? 'bad' : st.warning ? 'warn' : undefined} />} tone={st.on ? 'good' : undefined}>
      {!st.on ? <Muted>{t.mic.note}</Muted> : null}
      <MicButton on={st.on} busy={busy || st.state === 'starting'} onPress={toggle} label={st.on ? t.mic.stop : t.mic.start} />
      <LevelMeter level={st.level} threshold={st.threshold} on={st.on} />
      {st.on ? <Text style={s.small}>{t.mic.levelNote}</Text> : null}
      {st.reading ? <Text style={[s.body, { color: C.brand }]}>{t.mic.reading(st.reading)}</Text> : null}
      {st.warning ? <Text style={[s.body, { color: C.warn }]}>{st.warning}</Text> : null}
      <ErrorLine error={error} />
      {blocked ? <Button kind="warn" label={t.mic.openSettings} onPress={() => void Linking.openSettings()} /> : null}
      {st.lastError && !error ? <Text style={[s.small, { color: C.warn }]}>{t.mic.lastError(st.lastError)}</Text> : null}
      {st.on || st.heard.length ? <Text style={s.small}>{t.mic.counts(st.utterances, st.silent, st.dropped)}</Text> : null}
      {st.on || st.heard.length ? <Text style={s.label}>{t.mic.heard}</Text> : null}
      {st.on && !heard.length ? <Muted>{t.mic.nothingYet}</Muted> : null}
      {heard.map((h) => (
        <Row key={h.at} onPress={h.booked[0] ? () => nav.push({ name: 'entry', id: h.booked[0] }) : undefined}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.body}>“{h.text}”</Text>
            <Text style={[s.small, { color: h.booked.length ? C.good : C.muted }]}>
              {h.held ? t.mic.held : h.booked.length ? t.mic.booked(h.booked.length) : h.repeats ? t.mic.repeat : t.mic.smallTalk}
            </Text>
            {!h.booked.length && !h.repeats ? <AskKind text={h.text} source="voice" onBooked={(ids) => listener.markBooked(h.at, ids)} /> : null}
          </View>
          {h.booked.length ? <Text style={{ color: C.faint, fontSize: 22 }}>›</Text> : null}
        </Row>
      ))}
    </Card>
  );
}

/** Account names without accounting words. */
export function accountLabel(acct: string) {
  const [head, ...rest] = acct.split(':');
  const name = t.books.accounts[head] ?? head;
  const tail = rest.join(':');
  if (!tail || head === 'revenue' || head === 'equity') return name;
  return `${name}: ${cap(tail)}`;
}

export { C };
