// Stock aur barbaadi: count-to-count periods, the learned recipe, overnight changes, and where the waste
// went. Ported from frontend/src/views/Stock.tsx; computed on the phone from the ledger (inference.ts).
import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { listDays } from '../../core/days';
import { fuse } from '../../core/fusion';
import { attributeLoss, wastageFromLedger } from '../../core/inference';
import { ledger } from '../common';
import { Body, C, Card, Empty, Muted, Row, Screen, Segmented, Stepper, cap, fmtQty, pct, s, useLedgerVersion } from '../kit';
import { t } from '../strings';
import { worstWaste } from './Today';

const amount = (v: number, unit: string | null) => (unit === 'kg' ? `${Math.round(v * 1000)} g` : unit === 'l' ? `${Math.round(v * 1000)} ml` : `${fmtQty(v)} ${unit ?? ''}`);

export function Stock() {
  const v = useLedgerVersion();
  const data = useMemo(() => {
    const L = ledger();
    const all = L.store.all();
    const perishable = L.lexicon.data.perishable ?? [];
    return { stock: wastageFromLedger(fuse(all).effective, perishable), days: listDays(all), perishable };
  }, [v]);
  const names = Object.keys(data.stock.ingredients);
  const [pick, setPick] = useState<string | null>(null);
  const name = pick && names.includes(pick) ? pick : names[0] ?? null;
  const g: any = name ? data.stock.ingredients[name] : null;
  const worst = worstWaste(data.stock.ingredients);
  const dayOf = (i: number) => {
    const d = data.days.find((x) => x.index === i);
    return i === 0 ? t.today.beforeFirstDay : t.today.day(i, d?.date ?? null, !!d?.clock_suspect);
  };
  const line = !names.length ? t.stock.none : worst ? t.stock.worst(cap(worst.what), worst.days) : t.stock.counted(names.join(', '));

  return (
    <Screen title={t.stock.title} line={line}>
      {names.length > 1 ? <Segmented value={name ?? ''} onChange={setPick} options={names.map((n) => ({ value: n, label: n }))} /> : null}
      {g && name ? (
        <>
          <Card title={t.stock.periodsTitle(cap(name))}>
            <Muted>{t.stock.periodsNote}</Muted>
            {g.rows.length === 0 ? <Empty>{t.stock.onlyOne(name)}</Empty> : g.rows.map((r: any, i: number) => (
              <View key={i} style={[s.row, { flexDirection: 'column', alignItems: 'stretch' }]}>
                <Text style={[s.body, { fontWeight: '700' }]}>
                  {dayOf(r.from_day)}{r.to_day !== r.from_day ? ` → ${dayOf(r.to_day)}` : ''} · {t.stock.kinds[r.kind]}
                </Text>
                {r.note ? <Text style={{ color: C.warn }}>{r.note}</Text> : null}
                {r.start_kind === 'stock_count' && r.kind === 'trading' && r.from_day !== r.to_day ? <Muted>{t.stock.noMorning}</Muted> : null}
                <Body>
                  {t.stock.had} {fmtQty(r.start_qty)} + {t.stock.bought} {r.bought ? fmtQty(r.bought) : 0} − {t.stock.left} {fmtQty(r.end_qty)} = {t.stock.used}{' '}
                  <Text style={{ fontWeight: '800' }}>{r.burn == null ? '—' : `${fmtQty(r.burn)} ${g.unit ?? ''}`}</Text>
                </Body>
                {data.stock.dishes.filter((d: string) => r.plates[d]).map((d: string) => <Muted key={d}>{t.stock.plates(d, fmtQty(r.plates[d]))}</Muted>)}
              </View>
            ))}
            {g.status !== 'ok' ? <Muted>{cap(g.status)}.</Muted> : null}
          </Card>

          <Card title={t.stock.recipeTitle}>
            <Muted>{t.stock.recipeNote}</Muted>
            <Recipe stock={data.stock} />
          </Card>

          <Card title={t.stock.overnightTitle}>
            {g.overnight.length === 0 ? <Empty>{t.stock.overnightNone(name)}</Empty> : g.overnight.map((o: any, i: number) => (
              <Row key={i}>
                <Text style={[s.body, { flex: 1 }]}>{dayOf(o.from_day)} → {dayOf(o.to_day)}</Text>
                <Text style={[s.body, { fontWeight: '700' }]}>
                  {o.change > 0 ? t.stock.gone(`${fmtQty(o.change)} ${g.unit}`) : o.change < 0 ? t.stock.more(`${fmtQty(-o.change)} ${g.unit}`) : t.stock.noChange}
                </Text>
              </Row>
            ))}
          </Card>

          <Loss name={name} g={g} spoils={data.perishable.includes(name)} />
        </>
      ) : null}
    </Screen>
  );
}

function Recipe({ stock }: { stock: ReturnType<typeof wastageFromLedger> }) {
  const learned = Object.entries(stock.ingredients).filter(([, g]: any) => g.status === 'ok' && g.usage_per_dish) as [string, any][];
  if (!learned.length) return <Empty>{t.stock.recipeNone}</Empty>;
  return (
    <>
      {stock.dishes.map((dish) => {
        const parts = learned.map(([n, g]) => ({ n, v: g.usage_per_dish[dish] ?? 0, unit: g.unit })).filter((p) => p.v > 0.0005).map((p) => `${amount(p.v, p.unit)} ${p.n}`);
        return (
          <Row key={dish}>
            <Text style={[s.body, { fontWeight: '700' }]}>{t.stock.perPlate(dish)}</Text>
            <Text style={[s.body, { flex: 1, textAlign: 'right' }]}>{parts.join(' + ') || t.stock.nothingMeasurable}</Text>
          </Row>
        );
      })}
      <Muted>{t.stock.steady(learned.map(([n, g]) => `${amount(g.baseline_waste_per_period ?? 0, g.unit)} ${n}`).join(' · '))}</Muted>
    </>
  );
}

const CAUSE_COLORS = ['#B3261E', '#2F5DA8', '#A35400'];

function Loss({ name, g, spoils }: { name: string; g: any; spoils: boolean }) {
  const [temp, setTemp] = useState(32);
  const [away, setAway] = useState(0);
  const [family, setFamily] = useState(0);
  const kg = g.unexplained ?? 0;
  const loss = useMemo(
    () => (g.status === 'ok' ? attributeLoss(kg, { temperature_c: temp, unattended_hours: away, family_present: family, perishable: spoils }) : null),
    [g.status, kg, temp, away, family, spoils],
  );
  return (
    <Card title={t.stock.lossTitle}>
      <Muted>{t.stock.lossNote}</Muted>
      {!loss ? <Empty>{t.stock.lossNone(name)}</Empty> : (
        <>
          <Body style={{ fontWeight: '700' }}>{t.stock.lossTotal(`${fmtQty(kg)} ${g.unit}`, name, spoils)}</Body>
          <Stepper label={t.stock.temp} value={temp} min={15} max={48} unit="°C" onChange={setTemp} />
          <Stepper label={t.stock.away} value={away} min={0} max={10} unit={t.stock.hours} onChange={setAway} />
          <Stepper label={t.stock.family} value={family} min={0} max={6} unit={t.stock.people} onChange={setFamily} />
          <View style={{ flexDirection: 'row', height: 18, borderRadius: 9, overflow: 'hidden', marginTop: 6 }} accessibilityLabel={(['spoilage', 'theft', 'personal'] as const).map((k) => `${t.stock.causes[k]} ${pct(loss.split[k].p)}`).join(', ')}>
            {(['spoilage', 'theft', 'personal'] as const).map((k, i) => <View key={k} style={{ flex: loss.split[k].p, backgroundColor: CAUSE_COLORS[i] }} />)}
          </View>
          {(['spoilage', 'theft', 'personal'] as const).map((k, i) => (
            <Row key={k}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: CAUSE_COLORS[i] }} />
                <Text style={s.body}>{t.stock.causes[k]}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[s.body, { fontWeight: '800' }]}>{pct(loss.split[k].p)} · {fmtQty(loss.split[k].kg)} {g.unit}</Text>
                <Text style={s.small}>{t.stock.between(pct(loss.split[k].p10), pct(loss.split[k].p90))}</Text>
              </View>
            </Row>
          ))}
          {loss.reasons.length ? loss.reasons.map((r) => <Muted key={r}>• {cap(r)}</Muted>) : <Muted>{t.stock.usual}</Muted>}
        </>
      )}
    </Card>
  );
}
