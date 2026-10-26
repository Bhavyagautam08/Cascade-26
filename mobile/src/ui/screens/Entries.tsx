// Saare hisaab + one entry's detail. Ported from frontend/src/views/Entries.tsx.
import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Event } from '../../core/events';
import { fuse } from '../../core/fusion';
import { nameOf } from '../../core/identity';
import { causalOrder } from '../../core/store';
import { EditEntry, EntryRow, ReviewItem, amountText, confirmRemove, kindText, ledger, standing, tryRun, useNav, wallClock, what } from '../common';
import { Actions, Body, Button, C, Card, Conf, Empty, ErrorLine, KindTag, More, Muted, Pill, Row, Screen, Segmented, rupeesExact, s, useLedgerVersion } from '../kit';
import { t } from '../strings';

type Filter = 'all' | 'trade' | 'udhaar' | 'check' | 'corrections';

export function Entries() {
  const v = useLedgerVersion();
  const nav = useNav();
  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(30);
  const { events, st } = useMemo(() => {
    const all = ledger().store.all();
    return { events: causalOrder(all), st: standing(all, fuse(all)) };
  }, [v]);
  const match = (e: Event) =>
    filter === 'all' ||
    (filter === 'trade' && ['purchase', 'sale', 'expense', 'stock_count', 'order'].includes(e.kind)) ||
    (filter === 'udhaar' && (e.kind === 'credit_given' || e.kind === 'credit_paid')) ||
    (filter === 'check' && e.kind !== 'adjustment' && e.kind !== 'day_start' && !st.superseded.has(e.id)
      && (e.confidence < 0.6 || st.disputed.has(e.id) || (['purchase', 'sale', 'credit_given', 'credit_paid', 'expense'].includes(e.kind) && e.postings.length === 0))) ||
    (filter === 'corrections' && (e.kind === 'adjustment' || e.supersedes.length > 0 || st.superseded.has(e.id)));
  const rows = [...events].reverse().filter(match);

  return (
    <Screen title={t.entries.title} line={t.entries.line(events.length)} onBack={nav.pop}>
      <Segmented value={filter} onChange={(f) => (setFilter(f), setLimit(30))} options={(['all', 'trade', 'udhaar', 'check', 'corrections'] as Filter[]).map((f) => ({ value: f, label: t.entries.filters[f] }))} />
      <Card aside={<Text style={s.small}>{rows.length}</Text>}>
        {rows.length === 0 ? <Empty>{events.length ? t.entries.none : t.entries.nothing}</Empty> : rows.slice(0, limit).map((e) => filter === 'check' && !st.disputed.has(e.id) ? <ReviewItem key={e.id} e={e} /> : (
          <EntryRow
            key={e.id}
            e={e}
            gone={st.superseded.get(e.id)}
            onPress={() => nav.push({ name: 'entry', id: e.id })}
            marks={
              <>
                {st.fusedWith.has(e.id) ? <Pill tone="good">{t.entries.countedOnce}</Pill> : null}
                {st.disputed.has(e.id) ? <Pill>{t.entries.disputed}</Pill> : null}
                {st.maybeTwice.has(e.id) ? <Pill>{t.entries.maybeTwice}</Pill> : null}
              </>
            }
          />
        ))}
        {rows.length > limit ? <Button kind="plain" small label={t.entries.showMore(Math.min(50, rows.length - limit), rows.length)} onPress={() => setLimit((l) => l + 50)} /> : null}
      </Card>
    </Screen>
  );
}

export function EntryDetail({ id, edit }: { id: string; edit?: boolean }) {
  const v = useLedgerVersion();
  const nav = useNav();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!!edit);
  const [replacedBy, setReplacedBy] = useState<string | null>(null);
  const d = useMemo(() => {
    const all = ledger().store.all();
    return { all, e: all.find((x) => x.id === id) ?? null, st: standing(all, fuse(all)) };
  }, [v, id]);
  const { all, e, st } = d;
  if (!e) return <Screen title={id} onBack={nav.pop}><ErrorLine error={`no entry ${id}`} /></Screen>;
  const gone = st.superseded.get(e.id);
  const by = all.find((x) => x.supersedes.includes(e.id));
  const sum = e.postings.reduce((x, p) => x + p.amount, 0);
  const clock = wallClock(e.wall_time);
  const group = st.fusedWith.get(e.id);
  const disputed = st.disputed.has(e.id);
  const actionable = !gone && e.kind !== 'adjustment' && e.kind !== 'day_start' && !disputed;
  const link = (x: string) => (
    <Pressable key={x} onPress={() => nav.push({ name: 'entry', id: x })} accessibilityRole="link">
      <Text style={[s.mono, { color: C.brand, textDecorationLine: 'underline' }]}>{x}</Text>
    </Pressable>
  );

  return (
    <Screen title={`${kindText(e)}: ${what(e)}`} onBack={nav.pop}>
      <Card tone={gone ? undefined : e.confidence < 0.6 ? 'warn' : undefined}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <KindTag kind={e.kind} label={kindText(e)} />
          {gone ? <Pill tone="muted">{t.entries.gone[gone]}</Pill> : null}
          {disputed ? <Pill>{t.entries.disputed}</Pill> : null}
        </View>
        <Fact k={t.entry.amount}><Text style={[s.big, { fontSize: 26 }]}>{amountText(e)}</Text></Fact>
        {e.raw ? <Fact k={t.entry.said}><Body>“{e.raw}”</Body></Fact> : null}
        <Fact k={t.entry.sure}><Conf value={e.confidence} /></Fact>
        <Fact k={t.entry.came}><Body>{t.entry.on(t.record.sources[e.source] ?? e.source, nameOf(e.device_id))}</Body></Fact>
        {gone ? <Body style={{ color: C.muted }}>{t.entry.gone}</Body> : null}
        {gone && by ? <Fact k={t.entry.status}><Body>{gone === 'voided' ? t.entry.voidedBy : t.entry.settledBy}</Body><Button small kind="soft" label={t.entry.goNew} onPress={() => nav.push({ name: 'entry', id: by.id })} /></Fact> : null}
        {actionable ? (
          <Actions>
            {e.confidence < 1 && e.postings.length ? <Button small icon="✓" label={t.review.ok} onPress={() => tryRun(() => { const [n] = ledger().confirm(e.id); setReplacedBy(n.id); }, setError)} /> : null}
            <Button small kind="soft" icon="✎" label={t.review.edit} onPress={() => setEditing((x) => !x)} />
            <Button small kind="plain" icon="🗑" label={t.review.remove} onPress={() => confirmRemove(e, setError, nav.pop)} />
          </Actions>
        ) : null}
        <ErrorLine error={error} />
        {replacedBy ? <Body style={{ color: C.good }}>{t.entry.saved}</Body> : null}
      </Card>

      {editing && actionable ? <EditEntry e={e} onDone={(n) => { setEditing(false); setReplacedBy(n); }} /> : null}

      <More label={t.entry.technical}>
      <Card>
        <Text style={s.mono}>{e.id}</Text>
        {group ? <Fact k={t.entry.with}>{group.filter((x) => x !== e.id).map(link)}</Fact> : null}
        {e.supersedes.length ? <Fact k={t.entry.replaces}>{e.supersedes.map(link)}</Fact> : null}
      </Card>
      <Card title={t.entry.double}>
        {e.postings.length === 0 ? <Muted>{e.kind === 'adjustment' ? t.entry.noLinesVoid : t.entry.noLines}</Muted> : (
          <>
            <Row><Text style={[s.small, { flex: 1 }]}>{t.entry.account}</Text><Text style={[s.small, { width: 90, textAlign: 'right' }]}>{t.entry.debit}</Text><Text style={[s.small, { width: 90, textAlign: 'right' }]}>{t.entry.credit}</Text></Row>
            {e.postings.map((p, i) => (
              <Row key={i}>
                <Text style={[s.mono, { flex: 1, color: C.ink }]}>{p.account}</Text>
                <Text style={[s.body, { width: 90, textAlign: 'right' }]}>{p.amount > 0 ? rupeesExact(p.amount) : ''}</Text>
                <Text style={[s.body, { width: 90, textAlign: 'right' }]}>{p.amount < 0 ? rupeesExact(-p.amount) : ''}</Text>
              </Row>
            ))}
            <Body style={{ fontWeight: '700', color: sum === 0 ? C.good : C.bad }}>{sum === 0 ? t.entry.balanced : rupeesExact(sum)}</Body>
          </>
        )}
      </Card>

      <Card title={t.entry.history}>
        <Muted>{t.entry.historyNote}</Muted>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {Object.entries(e.vclock).sort().map(([dev, n]) => <Pill key={dev} tone="muted">{`${dev}  ${n}`}</Pill>)}
        </View>
        <Text style={[s.muted, clock.bad && { color: C.bad }]}>{e.wall_time == null ? t.entry.noClock : t.entry.clock(clock.text, clock.bad)}</Text>
      </Card>
      </More>
    </Screen>
  );
}

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 2, paddingVertical: 4 }}>
      <Text style={s.small}>{k}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>{children}</View>
    </View>
  );
}
