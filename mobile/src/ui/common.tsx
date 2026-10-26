// Pieces several screens share, ported from the dashboard (frontend/src/derive.ts, Dispute.tsx, Books.tsx).
import React, { createContext, useContext, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { service } from '../app/service';
import type { Event } from '../core/events';
import type { Conflict, FusionReport } from '../core/fusion';
import { nameOf } from '../core/identity';
import { Button, C, Card, Conf, ErrorLine, KindTag, Muted, Pill, Row, cap, fmtQty, inr, paise, s } from './kit';
import { t } from './strings';

export const ledger = () => service.ledger!;

// --- navigation: a tab plus a stack of pages (Android back pops the stack) -----------------------------
export type Page = { name: 'entries' } | { name: 'entry'; id: string } | { name: 'books' } | { name: 'words' } | { name: 'family' } | { name: 'diagnose' };
export const Nav = createContext<{ push: (p: Page) => void; pop: () => void; tab: (name: string) => void }>({ push: () => {}, pop: () => {}, tab: () => {} });
export const useNav = () => useContext(Nav);

// --- words for an entry ----------------------------------------------------------------------------------
export function what(e: Event): string {
  const p = e.payload as Record<string, any>;
  if (p.voided) return `${p.voided} hataya`;
  const qty = p.qty != null ? `${fmtQty(p.qty)} ${p.unit ?? ''}`.trim() : null;
  return [qty, p.item, p.party && cap(p.party)].filter(Boolean).join(' · ') || '—';
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
  return `${c.item ? `${c.item} ` : ''}${(t.kinds[c.kind] ?? c.kind).toLowerCase()}`;
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
          <KindTag kind={e.kind} />
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

/** Account names without accounting words. */
export function accountLabel(acct: string) {
  const [head, ...rest] = acct.split(':');
  const name = t.books.accounts[head] ?? head;
  const tail = rest.join(':');
  if (!tail || head === 'revenue' || head === 'equity') return name;
  return `${name}: ${cap(tail)}`;
}

export { C };
