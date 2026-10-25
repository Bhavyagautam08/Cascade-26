// The screens. Every number comes from the ledger (service.ledger); nothing here invents data.
import React, { useMemo, useState } from 'react';
import { Alert, ScrollView, Text, TextInput, View } from 'react-native';
import { service } from '../app/service';
import { dayOfEvents } from '../core/days';
import type { Event } from '../core/events';
import { nameOf } from '../core/identity';
import { causalOrder } from '../core/store';
import { Big, Button, C, Card, ErrorLine, Muted, cap, inr, paise, s, useLedgerVersion } from './kit';
import { t } from './strings';

const ledger = () => service.ledger!;
const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''));

export function what(e: Event): string {
  const p = e.payload as Record<string, any>;
  if (p.voided) return `${p.voided} hataya`;
  const qty = p.qty != null ? `${fmtQty(p.qty)} ${p.unit ?? ''}`.trim() : null;
  return [qty, p.item, p.party && cap(p.party)].filter(Boolean).join(' · ') || '—';
}
const amountOf = (e: Event) => e.postings.reduce((x, p) => x + Math.max(p.amount, 0), 0);
function subject(c: { kind: string; party: string | null; item: unknown }) {
  if ((c.kind === 'credit_paid' || c.kind === 'credit_given') && c.party) return `${cap(c.party)} ka ${c.kind === 'credit_paid' ? 'jama' : 'udhaar'}`;
  return `${c.item ? `${c.item} ` : ''}${(t.kinds[c.kind] ?? c.kind).toLowerCase()}`;
}
function tryRun(fn: () => void, setError: (e: string | null) => void) {
  try {
    fn();
    setError(null);
  } catch (e) {
    setError((e as Error).message);
  }
}

// --- first launch ------------------------------------------------------------------------------------
export function Setup({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('phone-1');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>{t.setup.title}</Text>
      <Muted>{t.setup.line}</Muted>
      <Card>
        <Text style={s.body}>{t.setup.name}</Text>
        <TextInput style={s.input} value={name} onChangeText={setName} autoCapitalize="none" autoCorrect={false} accessibilityLabel={t.setup.name} />
        <Text style={s.body}>{t.setup.key}</Text>
        <TextInput style={s.input} value={key} onChangeText={setKey} autoCapitalize="none" autoCorrect={false} accessibilityLabel={t.setup.key} />
        <Muted>{t.setup.keyHint}</Muted>
        <Button kind="plain" label={t.setup.newKey} onPress={() => setKey(Array.from({ length: 12 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join(''))} />
      </Card>
      <ErrorLine error={error} />
      <Button label={t.setup.save} onPress={() => tryRun(() => { service.open(name.trim(), key.trim()); onDone(); }, setError)} />
    </ScrollView>
  );
}

// --- Aaj (today) -------------------------------------------------------------------------------------
export function Today() {
  const v = useLedgerVersion();
  const [error, setError] = useState<string | null>(null);
  const data = useMemo(() => {
    const L = ledger();
    const sum = L.summary();
    const all = L.store.all();
    const of = dayOfEvents(all);
    const superseded = new Set(all.flatMap((e) => e.supersedes));
    const disputed = new Set(sum.conflicts.flatMap((c) => c.ids));
    const today = causalOrder(all).filter((e) => of[e.id] === sum.day.index && e.kind !== 'day_start').reverse();
    const unsure = today.filter((e) => e.kind !== 'adjustment' && !superseded.has(e.id) && !disputed.has(e.id) && e.confidence < 0.6);
    return { sum, today, unsure, superseded };
  }, [v]);
  const { sum, today, unsure, superseded } = data;
  const p = sum.profit;
  const owed = Object.values(sum.receivables).reduce((x, r) => x + Math.max(r, 0), 0);
  const dayText = sum.day.index === 0 ? t.today.beforeFirstDay : t.today.day(sum.day.index, sum.day.date);
  const needs = [
    ...sum.conflicts.map((c) => t.today.settle(subject(c))),
    ...sum.possible_duplicates.map((d) => t.today.twice(subject(d))),
    ...unsure.map((e) => t.today.unsure(`${t.kinds[e.kind]} ${what(e)}`)),
  ];
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1}>{t.today.title(dayText)}</Text>
      <Card title={t.today.earnings}>
        <Big>{p.p10 === p.p90 ? t.today.earningsSure(inr(p.p50)) : `${inr(p.p10)} – ${inr(p.p90)}`}</Big>
        {p.p10 !== p.p90 ? <Muted>{t.today.earningsRange(inr(p.p10), inr(p.p90), inr(p.p50))}</Muted> : null}
      </Card>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Card title={t.today.udhaar} style={{ flex: 1 }}>
          <Big style={{ fontSize: 24 }}>{inr(owed)}</Big>
        </Card>
        <Card title={t.today.cash} style={{ flex: 1 }}>
          <Big style={{ fontSize: 24 }}>{paise(sum.balances_paise.cash ?? 0)}</Big>
        </Card>
      </View>
      <Card title={t.today.needsYou}>
        {needs.length ? needs.slice(0, 6).map((n, i) => <Text key={i} style={[s.body, { color: C.warn }]}>• {n}</Text>) : <Muted>{t.today.nothingNeeded}</Muted>}
      </Card>
      <Card title={t.today.entries}>
        {today.length === 0 ? <Muted>{t.today.noEntries}</Muted> : today.slice(0, 40).map((e) => <EntryRow key={e.id} e={e} gone={superseded.has(e.id)} />)}
      </Card>
      <ErrorLine error={error} />
      <Button kind="plain" label={t.today.newDay} onPress={() => Alert.alert(t.today.newDay, t.today.newDayConfirm, [
        { text: 'Nahi', style: 'cancel' },
        { text: 'Haan', onPress: () => tryRun(() => ledger().newDay(), setError) },
      ])} />
    </ScrollView>
  );
}

function EntryRow({ e, gone }: { e: Event; gone?: boolean }) {
  const amt = amountOf(e);
  return (
    <View style={[s.row, gone && { opacity: 0.45 }]}>
      <View style={{ flex: 1 }}>
        <Text style={s.body}>{t.kinds[e.kind] ?? e.kind} · {what(e)}</Text>
        <Muted style={{ fontSize: 13 }}>“{e.raw ?? ''}” · {Math.round(e.confidence * 100)}% · {nameOf(e.device_id)}</Muted>
      </View>
      <Text style={[s.body, { fontWeight: '600' }]}>{amt ? paise(amt) : '—'}</Text>
    </View>
  );
}

// --- Likho (record) -----------------------------------------------------------------------------------
export function Record() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ events: Event[]; unparsed: string[]; fallback: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function add(source: 'manual' | 'sms') {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await ledger().handleText(text.trim(), source);
      setOut({ events: r.events, unparsed: r.unparsed, fallback: r.fallback_reason });
      setText('');
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>{t.record.title}</Text>
      <TextInput style={[s.input, { minHeight: 110, textAlignVertical: 'top', paddingTop: 12 }]} multiline value={text} onChangeText={setText} placeholder={t.record.placeholder} placeholderTextColor={C.muted} accessibilityLabel={t.record.title} />
      <Button label={t.record.add} onPress={() => add('manual')} disabled={busy || !text.trim()} />
      <Button kind="plain" label={t.record.sms} onPress={() => add('sms')} disabled={busy || !text.trim()} />
      <ErrorLine error={error} />
      {out ? (
        <Card title={out.events.length ? t.record.booked(out.events.length) : t.record.nothing}>
          {out.events.map((e) => <EntryRow key={e.id} e={e} />)}
          {out.unparsed.length ? <Text style={[s.body, { color: C.warn }]}>{t.record.unparsed}: {out.unparsed.join(' | ')}</Text> : null}
          {out.fallback ? <Muted>{t.record.rulesOnly(out.fallback)}</Muted> : null}
        </Card>
      ) : null}
      <Card>
        <Button kind="plain" label={`🎤  ${t.record.listen} · ${t.record.comingSoon}`} onPress={() => {}} disabled />
        <Button kind="plain" label={`📷  ${t.record.slip} · ${t.record.comingSoon}`} onPress={() => {}} disabled />
      </Card>
    </ScrollView>
  );
}

// --- disputes and "one or two?" (used by Udhaar and Aur) ----------------------------------------------
function Dispute({ c }: { c: ReturnType<ReturnType<typeof ledger>['summary']>['conflicts'][number] }) {
  const [other, setOther] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lo, hi] = c.claims_paise.map((x) => x / 100);
  const phones = c.ids.map((id) => nameOf(id.split(':')[0]));
  return (
    <Card style={{ borderColor: C.warn }}>
      <Text style={[s.body, { fontWeight: '600' }]}>{t.today.settle(subject(c))}</Text>
      <Muted>{t.dispute.phones(phones[0], phones[1])} · {t.dispute.booked(inr(lo))}</Muted>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}><Button label={t.dispute.itWas(inr(lo))} onPress={() => tryRun(() => ledger().resolve(c.ids, lo), setError)} /></View>
        <View style={{ flex: 1 }}><Button label={t.dispute.itWas(inr(hi))} onPress={() => tryRun(() => ledger().resolve(c.ids, hi), setError)} /></View>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput style={[s.input, { flex: 1 }]} keyboardType="numeric" placeholder={`${t.dispute.other} ₹`} value={other} onChangeText={setOther} />
        <Button label={t.dispute.set} disabled={!other || isNaN(Number(other))} onPress={() => tryRun(() => ledger().resolve(c.ids, Number(other)), setError)} />
      </View>
      <ErrorLine error={error} />
    </Card>
  );
}

function MaybeTwice({ d }: { d: ReturnType<ReturnType<typeof ledger>['summary']>['possible_duplicates'][number] }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Card style={{ borderColor: C.warn }}>
      <Text style={[s.body, { fontWeight: '600' }]}>{t.today.twice(`${subject(d)} ${paise(d.amount_paise)}`)}</Text>
      <Muted>{d.devices.map(nameOf).join(' + ')}</Muted>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}><Button label={t.dispute.one} onPress={() => tryRun(() => ledger().same(d.ids), setError)} /></View>
        <View style={{ flex: 1 }}><Button kind="plain" label={t.dispute.two} onPress={() => tryRun(() => ledger().separate(d.ids), setError)} /></View>
      </View>
      <ErrorLine error={error} />
    </Card>
  );
}

// --- Udhaar -------------------------------------------------------------------------------------------
export function Udhaar() {
  const v = useLedgerVersion();
  const sum = useMemo(() => ledger().summary(), [v]);
  const credit = sum.conflicts.filter((c) => (c.kind === 'credit_paid' || c.kind === 'credit_given') && c.party);
  const disputed = new Map(credit.map((c) => [c.party as string, c]));
  const parties = [...new Set([...Object.keys(sum.receivables), ...disputed.keys()])].map((p) => ({ p, owes: sum.receivables[p] ?? 0 })).sort((a, b) => b.owes - a.owes);
  const debtors = parties.filter((x) => x.owes > 0);
  const total = debtors.reduce((x, d) => x + d.owes, 0);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1}>{t.udhaar.title}</Text>
      <Muted>{debtors.length ? t.udhaar.total(debtors.length, inr(total)) : t.udhaar.none}</Muted>
      {credit.map((c) => <Dispute key={c.ids.join()} c={c} />)}
      <Card>
        {parties.map(({ p, owes }) => (
          <View key={p} style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={[s.body, { fontWeight: '600' }]}>{cap(p)}</Text>
              {disputed.get(p) ? <Text style={s.pill}>{t.udhaar.disputed(paise(disputed.get(p)!.suspense_paise))}</Text> : null}
            </View>
            <Text style={[s.body, { fontWeight: '700', fontSize: 20 }]}>{owes > 0 ? inr(owes) : owes < 0 ? t.udhaar.ahead(inr(-owes)) : t.udhaar.settled}</Text>
          </View>
        ))}
        {parties.length === 0 ? <Muted>{t.udhaar.none}</Muted> : null}
      </Card>
    </ScrollView>
  );
}

// --- Stock (counts come next) -------------------------------------------------------------------------
export function Stock() {
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1}>{t.stock.title}</Text>
      <Muted>{t.stock.soon}</Muted>
    </ScrollView>
  );
}

// --- Aur: books, decisions, family ---------------------------------------------------------------------
export function More() {
  const v = useLedgerVersion();
  const [error, setError] = useState<string | null>(null);
  const sum = useMemo(() => ledger().summary(), [v]);
  const all = useMemo(() => new Map(ledger().store.all().map((e) => [e.id, e])), [v]);
  const other = sum.conflicts.filter((c) => !((c.kind === 'credit_paid' || c.kind === 'credit_given') && c.party));
  const status = service.sync!.status();
  const rows = Object.entries(sum.balances_paise).filter(([, x]) => x !== 0).sort(([a], [b]) => a.localeCompare(b));
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1}>{t.more.title}</Text>
      {other.map((c) => <Dispute key={c.ids.join()} c={c} />)}
      {sum.possible_duplicates.map((d) => <MaybeTwice key={d.ids.join()} d={d} />)}
      <Card title={t.more.books}>
        <Text style={[s.body, { color: sum.balanced ? C.good : C.bad, fontWeight: '600' }]}>{sum.balanced ? t.more.balanced : t.more.notBalanced}</Text>
        {rows.map(([acct, x]) => (
          <View key={acct} style={s.row}>
            <Text style={[s.body, { flex: 1 }]}>{acct}</Text>
            <Text style={s.body}>{paise(x)}</Text>
          </View>
        ))}
      </Card>
      <Card title={t.more.countedOnce}>
        {sum.duplicates.length === 0 ? <Muted>—</Muted> : sum.duplicates.map((g) => (
          <View key={g.join()} style={{ gap: 6, paddingVertical: 6 }}>
            {g.map((id) => all.get(id)).filter(Boolean).map((e) => <EntryRow key={e!.id} e={e!} />)}
            <Button kind="plain" label={t.more.different} onPress={() => tryRun(() => ledger().separate(g), setError)} />
          </View>
        ))}
      </Card>
      <Card title={t.more.family}>
        <Text style={s.body}>{t.more.thisPhone}: {status.name} · {status.actor}</Text>
        {status.peers.length === 0 ? <Muted>{t.more.noPeers}</Muted> : status.peers.map((p) => (
          <View key={p.url} style={s.row}>
            <Text style={[s.body, { flex: 1 }]}>{p.name ?? p.url}</Text>
            <Text style={{ color: p.state === 'ok' ? C.good : C.warn }}>
              {p.state === 'ok' ? t.more.peerOk(t.secondsAgo(p.lastOkSAgo ?? 0)) : p.state === 'unreachable' ? t.more.peerAway : p.state === 'refused' ? t.more.peerRefused : p.state === 'error' ? `${t.more.peerError}: ${p.lastError}` : '—'}
            </Text>
          </View>
        ))}
      </Card>
      <ErrorLine error={error} />
    </ScrollView>
  );
}
