// Udhaar ki kitaab: who owes what, settle disputes, write new udhaar, and per customer: record a payment,
// clear the account, give more, or fix a wrong entry. Every action is a ledger entry (so it syncs), never a
// screen-only change. Ported in spirit from frontend/src/views/Udhaar.tsx.
import React, { useMemo, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { fuse } from '../../core/fusion';
import { Dispute, EntryRow, isUdhaar, ledger, standing, tryRun, useNav } from '../common';
import { Actions, Big, Body, Button, C, Card, Empty, ErrorLine, Field, Input, Muted, Row, Screen, cap, inr, paise, s, useLedgerVersion } from '../kit';
import { t } from '../strings';

function amountOf(text: string): number {
  const n = Number(text.replace(/,/g, '').replace(/^₹/, ''));
  if (!text.trim() || !Number.isFinite(n) || n <= 0) throw new Error(t.udhaar.needAmount);
  return n;
}

export function Udhaar() {
  const v = useLedgerVersion();
  const nav = useNav();
  const sum = useMemo(() => ledger().summary(), [v]);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const conflicts = sum.conflicts.filter((c) => isUdhaar(c.kind) && c.party); // sales disputes live in the khaata
  const disputed = new Map(conflicts.map((c) => [c.party as string, c]));
  const parties = [...new Set([...Object.keys(sum.receivables), ...disputed.keys()])]
    .map((p) => ({ p, owes: sum.receivables[p] ?? 0 }))
    .sort((a, b) => b.owes - a.owes);
  const debtors = parties.filter((x) => x.owes > 0);
  const total = debtors.reduce((x, d) => x + d.owes, 0);

  const write = (kind: 'given' | 'paid') => tryRun(() => {
    if (!name.trim()) throw new Error(t.udhaar.needName);
    const rupees = amountOf(amount);
    if (kind === 'given') ledger().udhaarGiven(name, rupees);
    else ledger().udhaarPaid(name, rupees);
    setSaved(t.udhaar.saved(`${cap(name.trim())} · ${kind === 'given' ? t.udhaar.give : t.udhaar.got} ${inr(rupees)}`));
    setName('');
    setAmount('');
  }, setError);

  return (
    <Screen title={t.udhaar.title} line={debtors.length ? t.udhaar.total(debtors.length, inr(total)) : t.udhaar.none}>
      {conflicts.length ? (
        <>
          <Text style={[s.cardTitle, { color: C.warn }]}>{t.udhaar.disputesTitle}</Text>
          <Muted>{t.udhaar.disputesNote}</Muted>
          {conflicts.map((c) => <Dispute key={c.ids.join()} c={c} />)}
        </>
      ) : null}

      <Card title={t.today.udhaar} aside={<Big style={{ fontSize: 22 }}>{inr(total)}</Big>}>
        {parties.length ? <Muted>{t.udhaar.tapHint}</Muted> : null}
        {parties.length === 0 ? <Empty>{t.udhaar.none}</Empty> : parties.map(({ p, owes }) => {
          const c = disputed.get(p);
          return (
            <Row key={p} onPress={() => nav.push({ name: 'party', party: p })}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={[s.body, { fontWeight: '700', fontSize: 19 }]}>{cap(p)}</Text>
                {c ? <Text style={{ color: C.warn }}>{t.udhaar.disputed(paise(c.suspense_paise), c.kind === 'credit_paid')}</Text> : null}
              </View>
              {owes > 0 ? <Text style={[s.body, { fontWeight: '800', fontSize: 21 }]}>{inr(owes)}</Text>
                : owes < 0 ? <Text style={{ color: C.good }}>{t.udhaar.ahead(inr(-owes))}</Text>
                : <Text style={{ color: C.faint }}>{t.udhaar.settled}</Text>}
              <Text style={{ color: C.faint, fontSize: 24 }}>›</Text>
            </Row>
          );
        })}
      </Card>

      <Card title={t.udhaar.newTitle}>
        <Field label={t.udhaar.name}><Input value={name} onChangeText={(x) => { setName(x); setSaved(null); }} placeholder="Sharma ji" accessibilityLabel={t.udhaar.name} /></Field>
        <Field label={t.udhaar.amount}><Input value={amount} onChangeText={(x) => { setAmount(x); setSaved(null); }} keyboardType="decimal-pad" placeholder="60" accessibilityLabel={t.udhaar.amount} /></Field>
        <Actions>
          <Button icon="📕" label={t.udhaar.give} kind="warn" onPress={() => write('given')} />
          <Button icon="💰" label={t.udhaar.got} onPress={() => write('paid')} />
        </Actions>
        <ErrorLine error={error} />
        {saved ? <Body style={{ color: C.good }}>{saved}</Body> : null}
      </Card>

      <Card title={t.udhaar.howTitle}>
        {t.udhaar.how.map((line) => <Body key={line}>• {line}</Body>)}
        <Muted>{t.udhaar.note}</Muted>
      </Card>
    </Screen>
  );
}

/** One customer's udhaar: balance, take a payment, clear it, give more, and every entry to fix. */
export function Party({ party }: { party: string }) {
  const v = useLedgerVersion();
  const nav = useNav();
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const d = useMemo(() => {
    const L = ledger();
    const sum = L.summary();
    const all = L.store.all();
    const st = standing(all, fuse(all));
    return { owes: sum.receivables[party] ?? 0, history: L.udhaarHistory(party).reverse(), gone: st.superseded, conflict: sum.conflicts.find((c) => isUdhaar(c.kind) && c.party === party) ?? null };
  }, [v, party]);
  const name = cap(party);

  const act = (kind: 'paid' | 'given', rupees: number) => tryRun(() => {
    if (kind === 'paid') ledger().udhaarPaid(party, rupees);
    else ledger().udhaarGiven(party, rupees);
    setSaved(t.udhaar.saved(`${kind === 'paid' ? t.udhaar.got : t.udhaar.give} ${inr(rupees)}`));
    setAmount('');
  }, setError);

  return (
    <Screen title={name} onBack={nav.pop}>
      <Card title={t.udhaar.owes} tone={d.owes > 0 ? 'warn' : 'good'}>
        <Big>{d.owes > 0 ? inr(d.owes) : d.owes < 0 ? t.udhaar.ahead(inr(-d.owes)) : t.udhaar.settled}</Big>
        {d.owes > 0 ? (
          <Button icon="✅" label={t.udhaar.paidFull(inr(d.owes))} onPress={() => Alert.alert(t.udhaar.got, t.udhaar.clearConfirm(name, inr(d.owes)), [
            { text: t.today.no, style: 'cancel' },
            { text: t.today.yes, onPress: () => act('paid', d.owes) },
          ])} />
        ) : null}
        <Field label={t.udhaar.amount}><Input value={amount} onChangeText={(x) => { setAmount(x); setSaved(null); }} keyboardType="decimal-pad" placeholder="50" accessibilityLabel={t.udhaar.amount} /></Field>
        <Actions>
          <Button small icon="💰" label={t.udhaar.paidSome} onPress={() => tryRun(() => act('paid', amountOf(amount)), setError)} />
          <Button small kind="warn" icon="📕" label={t.udhaar.gaveMore} onPress={() => tryRun(() => act('given', amountOf(amount)), setError)} />
        </Actions>
        <ErrorLine error={error} />
        {saved ? <Body style={{ color: C.good }}>{saved}</Body> : null}
      </Card>

      {d.conflict ? <Dispute c={d.conflict} /> : null}

      <Card title={t.udhaar.history}>
        <Muted>{t.udhaar.historyNote}</Muted>
        {d.history.length === 0 ? <Empty>{t.udhaar.noHistory}</Empty> : d.history.map((h) => (
          <EntryRow key={h.event.id} e={h.event} gone={d.gone.get(h.event.id)} onPress={() => nav.push({ name: 'entry', id: h.event.id })} />
        ))}
      </Card>
    </Screen>
  );
}
