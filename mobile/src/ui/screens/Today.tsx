// Aaj: start the day, keep the mic on, see the day's true earnings, and settle what needs the vendor —
// each entry to check has its own ✓ Sahi / ✎ Badlo / 🗑 Hatao. Every figure comes from the ledger.
import React, { useMemo, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { dayOfEvents } from '../../core/days';
import { fuse } from '../../core/fusion';
import { wastageFromLedger } from '../../core/inference';
import { causalOrder } from '../../core/store';
import { Dispute, EntryRow, MaybeTwice, MicPanel, ReviewItem, itemName, ledger, standing, tryRun, useNav } from '../common';
import { Big, Body, Button, C, Card, ErrorLine, Muted, RangeBar, Screen, Tile, cap, inr, paise, s, useLedgerVersion } from '../kit';
import { t } from '../strings';
import { useDownloads } from './Models';

export function worstWaste(ingredients: Record<string, any>) {
  const ok = Object.entries(ingredients).filter(([, g]) => g.status === 'ok' && g.unexplained != null);
  if (!ok.length) return null;
  const [name, g] = ok.reduce((a, b) => ((b[1].unexplained ?? 0) > (a[1].unexplained ?? 0) ? b : a));
  return { what: `${(g.unexplained as number).toFixed(2)} ${g.unit ?? ''} ${itemName(name)}`, days: g.periods as number };
}

const MONEY = ['purchase', 'sale', 'credit_given', 'credit_paid', 'expense'];

export function Today() {
  const v = useLedgerVersion();
  const nav = useNav();
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const dl = useDownloads();
  const d = useMemo(() => {
    const L = ledger();
    const sum = L.summary();
    const all = L.store.all();
    const rep = fuse(all);
    const st = standing(all, rep);
    const of = dayOfEvents(all);
    const today = causalOrder(all).filter((e) => of[e.id] === sum.day.index && e.kind !== 'day_start' && e.kind !== 'adjustment').reverse();
    const live = today.filter((e) => !st.superseded.has(e.id) && !st.disputed.has(e.id) && !st.maybeTwice.has(e.id));
    const review = live.filter((e) => e.confidence < 0.6 || (MONEY.includes(e.kind) && e.postings.length === 0));
    const waste = worstWaste(wastageFromLedger(rep.effective, L.lexicon.data.perishable ?? []).ingredients);
    const byId = new Map(all.map((e) => [e.id, e]));
    return { sum, today, review, st, waste, byId };
  }, [v]);
  const { sum, today, review, st, waste, byId } = d;
  const p = sum.profit;
  const owed = Object.values(sum.receivables).reduce((x, r) => x + Math.max(r, 0), 0);
  const debtors = Object.values(sum.receivables).filter((r) => r > 0).length;
  const suspense = sum.conflicts.reduce((x, c) => x + c.suspense_paise, 0);
  const sure = p.p10 === p.p90;
  const noDay = sum.day.index === 0;
  const toCheck = sum.conflicts.length + sum.possible_duplicates.length + review.length;

  function newDay() {
    Alert.alert(t.today.newDay, t.today.newDayConfirm, [
      { text: t.today.no, style: 'cancel' },
      { text: t.today.yes, onPress: () => tryRun(() => { ledger().newDay(); setStarted(true); }, setError) },
    ]);
  }

  return (
    <Screen title={t.today.title} line={noDay ? t.today.beforeFirstDay : t.today.day(sum.day.index, sum.day.date, sum.day.clock_suspect)}>
      {noDay ? (
        <Card title={t.today.startTitle} style={{ backgroundColor: C.brandSoft, borderColor: C.brand, borderWidth: 2 }}>
          <Body>{t.today.startNote}</Body>
          <Button icon="🌅" label={t.today.startButton} onPress={() => tryRun(() => { ledger().newDay(); setStarted(true); }, setError)} />
        </Card>
      ) : (
        <Card title={t.today.running(sum.day.index, sum.day.date)} tone="good">
          {started ? <Body style={{ color: C.good, fontWeight: '700' }}>{t.today.started}</Body> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Button small kind="soft" icon="📦" label={t.today.morningStock} onPress={() => nav.tab('stock')} /></View>
            <View style={{ flex: 1 }}><Button small kind="plain" icon="🌅" label={t.today.startButton} onPress={newDay} /></View>
          </View>
        </Card>
      )}
      <ErrorLine error={error} />

      {!dl.allReady() && Object.keys(dl.states).length ? (
        <Tile title={t.models.title} onPress={() => nav.push({ name: 'models' })} cta={t.models.bannerCta} tone="warn">
          <Body>{t.models.banner}</Body>
        </Tile>
      ) : null}

      <MicPanel compact />

      {toCheck ? (
        <Card title={`${t.review.title} (${toCheck})`} tone="warn">
          <Muted>{t.review.note}</Muted>
          {sum.conflicts.map((c) => <Dispute key={c.ids.join()} c={c} />)}
          {sum.possible_duplicates.map((x) => <MaybeTwice key={x.ids.join()} d={x} byId={byId} />)}
          {review.slice(0, 6).map((e) => <ReviewItem key={e.id} e={e} />)}
          {review.length > 6 ? <Button small kind="plain" label={t.review.more(review.length - 6)} onPress={() => nav.push({ name: 'entries' })} /> : null}
        </Card>
      ) : (
        <Card><Body style={{ color: C.good, fontWeight: '700' }}>{t.review.none}</Body></Card>
      )}

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
        <Tile title={t.today.udhaar} onPress={() => nav.tab('udhaar')} cta={t.today.udhaarCta} style={{ flex: 1 }}>
          <Big style={{ fontSize: 24 }}>{inr(owed)}</Big>
          {debtors ? <Text style={s.small}>{t.udhaar.total(debtors, inr(owed))}</Text> : null}
          {suspense ? <Text style={{ color: C.warn }}>{t.today.disputed(paise(suspense))}</Text> : null}
        </Tile>
        <Card title={t.today.cash} style={{ flex: 1 }}>
          <Big style={{ fontSize: 24 }}>{paise(sum.balances_paise.cash ?? 0)}</Big>
        </Card>
      </View>

      <Tile title={t.today.waste} onPress={() => nav.tab('stock')} cta={t.today.wasteCta} tone={waste ? 'warn' : undefined}>
        {waste ? <Body>{t.today.wasteLine(cap(waste.what), waste.days)}</Body> : <Muted>{t.today.wasteNone}</Muted>}
      </Tile>

      <Card title={t.today.entries} aside={<Text style={s.small}>{today.length}</Text>}>
        {today.length === 0 ? <Muted>{t.today.noEntries}</Muted> : today.slice(0, 30).map((e) => (
          <EntryRow key={e.id} e={e} gone={st.superseded.get(e.id)} onPress={() => nav.push({ name: 'entry', id: e.id })} />
        ))}
        <Button small kind="plain" label={t.today.allEntries} onPress={() => nav.push({ name: 'entries' })} />
      </Card>
    </Screen>
  );
}
