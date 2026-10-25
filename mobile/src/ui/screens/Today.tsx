// Aaj: today's true earnings (a range), udhaar, cash, where stock went, what needs the vendor, today's entries.
// Ported from frontend/src/views/Today.tsx. Every figure comes from the ledger.
import React, { useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { dayOfEvents } from '../../core/days';
import { fuse } from '../../core/fusion';
import { wastageFromLedger } from '../../core/inference';
import { causalOrder } from '../../core/store';
import { EntryRow, isUdhaar, ledger, standing, subject, tryRun, useNav, what } from '../common';
import { Big, Body, Button, C, Card, ErrorLine, Muted, RangeBar, Screen, cap, inr, paise, s, useLedgerVersion } from '../kit';
import { t } from '../strings';

export function worstWaste(ingredients: Record<string, any>) {
  const ok = Object.entries(ingredients).filter(([, g]) => g.status === 'ok' && g.unexplained != null);
  if (!ok.length) return null;
  const [name, g] = ok.reduce((a, b) => ((b[1].unexplained ?? 0) > (a[1].unexplained ?? 0) ? b : a));
  return { what: `${(g.unexplained as number).toFixed(2)} ${g.unit ?? ''} ${name}`, days: g.periods as number };
}

export function Today() {
  const v = useLedgerVersion();
  const nav = useNav();
  const [error, setError] = useState<string | null>(null);
  const d = useMemo(() => {
    const L = ledger();
    const sum = L.summary();
    const all = L.store.all();
    const rep = fuse(all);
    const st = standing(all, rep);
    const of = dayOfEvents(all);
    const today = causalOrder(all).filter((e) => of[e.id] === sum.day.index && e.kind !== 'day_start').reverse();
    const unsure = today.filter((e) => e.kind !== 'adjustment' && !st.superseded.has(e.id) && !st.disputed.has(e.id) && e.confidence < 0.6);
    const waste = worstWaste(wastageFromLedger(rep.effective, L.lexicon.data.perishable ?? []).ingredients);
    return { sum, today, unsure, st, waste };
  }, [v]);
  const { sum, today, unsure, st, waste } = d;
  const p = sum.profit;
  const owed = Object.values(sum.receivables).reduce((x, r) => x + Math.max(r, 0), 0);
  const suspense = sum.conflicts.reduce((x, c) => x + c.suspense_paise, 0);
  const dayText = sum.day.index === 0 ? t.today.beforeFirstDay : t.today.day(sum.day.index, sum.day.date, sum.day.clock_suspect);
  const sure = p.p10 === p.p90;

  const needs: { key: string; text: string; go: () => void }[] = [
    ...sum.conflicts.map((c) => ({ key: c.ids.join(), text: t.today.settle(subject(c)), go: () => (isUdhaar(c.kind) && c.party ? nav.tab('udhaar') : nav.push({ name: 'books' })) })),
    ...sum.possible_duplicates.map((x) => ({ key: x.ids.join(), text: t.today.twice(`${subject(x)} ${paise(x.amount_paise)}`), go: () => nav.push({ name: 'books' }) })),
    ...unsure.map((e) => ({ key: e.id, text: t.today.unsure(`${t.kinds[e.kind]}: ${what(e)}`), go: () => nav.push({ name: 'entry', id: e.id }) })),
  ];
  if (sum.incomplete.length) needs.push({ key: 'incomplete', text: t.today.incomplete(sum.incomplete.length), go: () => nav.push({ name: 'entries' }) });

  return (
    <Screen title={t.today.title} line={dayText}>
      <Card title={t.today.earnings} style={{ backgroundColor: C.head, borderColor: C.head }}>
        <Big style={{ color: '#fff' }}>{sure ? inr(p.p50) : `${inr(p.p10)} – ${inr(p.p90)}`}</Big>
        {sure ? <Text style={{ color: '#CFE5DD', fontSize: 15 }}>{t.today.earningsSure}</Text> : (
          <>
            <RangeBar lo={p.p10} mid={p.p50} hi={p.p90} />
            <Text style={{ color: '#CFE5DD', fontSize: 15 }}>{t.today.earningsRange(inr(p.p10), inr(p.p90), inr(p.p50))}</Text>
          </>
        )}
        <Text style={{ color: '#9FC7B9', fontSize: 13 }}>
          {t.today.earningsParts(inr(p.components.revenue), inr(p.components.cogs), inr(p.components.expenses), inr(p.components.expected_bad_debt))}
        </Text>
      </Card>

      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Pressable style={{ flex: 1 }} onPress={() => nav.tab('udhaar')} accessibilityRole="button">
          <Card title={t.today.udhaar}>
            <Big style={{ fontSize: 24 }}>{inr(owed)}</Big>
            {suspense ? <Text style={{ color: C.warn }}>{t.today.disputed(paise(suspense))}</Text> : null}
          </Card>
        </Pressable>
        <Card title={t.today.cash} style={{ flex: 1 }}>
          <Big style={{ fontSize: 24 }}>{paise(sum.balances_paise.cash ?? 0)}</Big>
        </Card>
      </View>

      <Pressable onPress={() => nav.tab('stock')} accessibilityRole="button">
        <Card title={t.today.waste}>
          {waste ? <Body>{t.today.wasteLine(cap(waste.what), waste.days)}</Body> : <Muted>{t.today.wasteNone}</Muted>}
        </Card>
      </Pressable>

      <Card title={t.today.needsYou} tone={needs.length ? 'warn' : undefined}>
        {needs.length === 0 ? <Body style={{ color: C.good }}>{t.today.nothingNeeded}</Body> : needs.slice(0, 8).map((n) => (
          <Pressable key={n.key} onPress={n.go} accessibilityRole="button" style={[s.row, { paddingVertical: 10 }]}>
            <Text style={[s.body, { flex: 1, color: C.warn }]}>{n.text}</Text>
            <Text style={{ color: C.faint, fontSize: 22 }}>›</Text>
          </Pressable>
        ))}
      </Card>

      <Card title={t.today.entries} aside={<Text style={s.small}>{today.length}</Text>}>
        {today.length === 0 ? <Muted>{t.today.noEntries}</Muted> : today.slice(0, 50).map((e) => (
          <EntryRow key={e.id} e={e} gone={st.superseded.get(e.id)} onPress={() => nav.push({ name: 'entry', id: e.id })} />
        ))}
      </Card>

      <ErrorLine error={error} />
      <Button kind="plain" label={t.today.newDay} onPress={() => Alert.alert(t.today.newDay, t.today.newDayConfirm, [
        { text: t.today.no, style: 'cancel' },
        { text: t.today.yes, onPress: () => tryRun(() => ledger().newDay(), setError) },
      ])} />
    </Screen>
  );
}
