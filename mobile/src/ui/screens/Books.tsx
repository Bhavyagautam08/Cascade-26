// Pura khaata: trial balance, sale disputes ("heard differently"), "one trade or two?", and what was
// counted once (with "these are different trades"). Ported from frontend/src/views/Books.tsx.
import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { Event } from '../../core/events';
import { fuse } from '../../core/fusion';
import { nameOf } from '../../core/identity';
import { Dispute, MaybeTwice, accountLabel, grossPaise, isUdhaar, ledger, tryRun, useNav, what } from '../common';
import { Body, Button, C, Card, Conf, Empty, ErrorLine, KindTag, Muted, Row, Screen, rupeesExact, s, paise, useLedgerVersion } from '../kit';
import { t } from '../strings';

const ORDER = ['cash', 'inventory', 'receivable', 'suspense', 'revenue', 'expense', 'equity'];

export function Books() {
  const v = useLedgerVersion();
  const nav = useNav();
  const d = useMemo(() => {
    const all = ledger().store.all();
    return { sum: ledger().summary(), rep: fuse(all), byId: new Map(all.map((e) => [e.id, e])) };
  }, [v]);
  const { sum, rep, byId } = d;
  const rows = Object.entries(sum.balances_paise)
    .filter(([, x]) => x !== 0)
    .sort(([a], [b]) => ORDER.indexOf(a.split(':')[0]) - ORDER.indexOf(b.split(':')[0]) || a.localeCompare(b));
  const debit = rows.reduce((x, [, y]) => x + Math.max(y, 0), 0);
  const credit = rows.reduce((x, [, y]) => x + Math.max(-y, 0), 0);
  const heard = sum.conflicts.filter((c) => !(isUdhaar(c.kind) && c.party)); // udhaar disputes: Udhaar tab
  const groups = rep.duplicates.map((g) => g.map((id) => byId.get(id)).filter((e): e is NonNullable<typeof e> => !!e));

  return (
    <Screen title={t.books.title} line={sum.balanced ? t.books.balanced(rupeesExact(debit)) : t.books.notBalanced} onBack={nav.pop}>
      {heard.length ? (
        <>
          <Text style={[s.cardTitle, { color: C.warn }]}>{t.books.heardTitle}</Text>
          <Muted>{t.books.heardNote}</Muted>
          {heard.map((c) => <Dispute key={c.ids.join()} c={c} />)}
        </>
      ) : null}
      {sum.possible_duplicates.length ? (
        <>
          <Text style={[s.cardTitle, { color: C.warn }]}>{t.books.twiceTitle}</Text>
          <Muted>{t.books.twiceNote}</Muted>
          {sum.possible_duplicates.map((x) => <MaybeTwice key={x.ids.join()} d={x} byId={byId} />)}
        </>
      ) : null}

      <Card title={t.books.trial} aside={<Text style={{ color: sum.balanced ? C.good : C.bad, fontWeight: '700' }}>{sum.balanced ? `✓ ${t.books.ok}` : t.books.notOk}</Text>}>
        <Muted>{t.books.trialNote}</Muted>
        {rows.length === 0 ? <Empty>{t.books.nothing}</Empty> : (
          <>
            <Row><Text style={[s.small, { flex: 1 }]}>{t.entry.account}</Text><Text style={[s.small, { width: 92, textAlign: 'right' }]}>{t.entry.debit}</Text><Text style={[s.small, { width: 92, textAlign: 'right' }]}>{t.entry.credit}</Text></Row>
            {rows.map(([acct, x]) => (
              <Row key={acct}>
                <View style={{ flex: 1 }}>
                  <Text style={s.body}>{accountLabel(acct)}</Text>
                  <Text style={s.mono}>{acct}</Text>
                </View>
                <Text style={[s.body, { width: 92, textAlign: 'right' }]}>{x > 0 ? rupeesExact(x) : ''}</Text>
                <Text style={[s.body, { width: 92, textAlign: 'right' }]}>{x < 0 ? rupeesExact(-x) : ''}</Text>
              </Row>
            ))}
            <Row>
              <Text style={[s.body, { flex: 1, fontWeight: '800' }]}>{t.books.total}</Text>
              <Text style={[s.body, { width: 92, textAlign: 'right', fontWeight: '800' }]}>{rupeesExact(debit)}</Text>
              <Text style={[s.body, { width: 92, textAlign: 'right', fontWeight: '800' }]}>{rupeesExact(credit)}</Text>
            </Row>
          </>
        )}
      </Card>

      <Card title={t.books.onceTitle}>
        <Muted>{t.books.onceNote}</Muted>
        {groups.length === 0 ? <Empty>{t.books.onceNone}</Empty> : groups.map((g) => <Once key={g.map((e) => e.id).join()} g={g} />)}
      </Card>
    </Screen>
  );
}

/** One witness per source counts: a second phone's ear is not independent evidence (fusion.ts). */
function Once({ g }: { g: Event[] }) {
  const [error, setError] = useState<string | null>(null);
  const perSource = new Map(g.map((e) => [e.source, e]));
  const best = g.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  const together = perSource.size > 1 ? 1 - [...perSource.values()].reduce((miss, e) => miss * (1 - e.confidence), 1) : best.confidence;
  return (
    <View style={{ gap: 6, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <KindTag kind={best.kind} />
        <Text style={[s.body, { flex: 1, fontWeight: '700' }]}>{what(best)}</Text>
        <Text style={[s.body, { fontWeight: '800' }]}>{paise(grossPaise(best))}</Text>
      </View>
      {g.map((e) => (
        <View key={e.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[s.small, { width: 70 }]}>{t.record.sources[e.source] ?? e.source}</Text>
          <Text style={[s.small, { flex: 1 }]} numberOfLines={1}>{nameOf(e.device_id)} · “{e.raw}”</Text>
          <Conf value={e.confidence} />
        </View>
      ))}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Body style={{ flex: 1 }}>{t.books.together}</Body>
        <Conf value={together} />
      </View>
      <Button small kind="plain" label={t.books.different} onPress={() => tryRun(() => ledger().separate(g.map((e) => e.id)), setError)} />
      <ErrorLine error={error} />
    </View>
  );
}
