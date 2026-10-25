// Udhaar ki kitaab: who owes what (certain part), disputes to settle. Ported from frontend/src/views/Udhaar.tsx.
import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import { Dispute, isUdhaar, ledger } from '../common';
import { Big, Body, C, Card, Empty, Muted, Row, Screen, cap, inr, paise, s, useLedgerVersion } from '../kit';
import { t } from '../strings';

export function Udhaar() {
  const v = useLedgerVersion();
  const sum = useMemo(() => ledger().summary(), [v]);
  const conflicts = sum.conflicts.filter((c) => isUdhaar(c.kind) && c.party); // sales disputes live in the khaata
  const disputed = new Map(conflicts.map((c) => [c.party as string, c]));
  const parties = [...new Set([...Object.keys(sum.receivables), ...disputed.keys()])]
    .map((p) => ({ p, owes: sum.receivables[p] ?? 0 }))
    .sort((a, b) => b.owes - a.owes);
  const debtors = parties.filter((x) => x.owes > 0);
  const total = debtors.reduce((x, d) => x + d.owes, 0);

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
        <Muted>{t.udhaar.note}</Muted>
        {parties.length === 0 ? <Empty>{t.udhaar.none}</Empty> : parties.map(({ p, owes }) => {
          const c = disputed.get(p);
          return (
            <Row key={p}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={[s.body, { fontWeight: '700', fontSize: 19 }]}>{cap(p)}</Text>
                {c ? <Text style={{ color: C.warn }}>{t.udhaar.disputed(paise(c.suspense_paise), c.kind === 'credit_paid')}</Text> : null}
              </View>
              {owes > 0 ? <Text style={[s.body, { fontWeight: '800', fontSize: 21 }]}>{inr(owes)}</Text>
                : owes < 0 ? <Text style={{ color: C.good }}>{t.udhaar.ahead(inr(-owes))}</Text>
                : <Text style={{ color: C.faint }}>{t.udhaar.settled}</Text>}
            </Row>
          );
        })}
      </Card>
      <Card title={t.udhaar.howTitle}>
        {t.udhaar.how.map((line) => <Body key={line}>• {line}</Body>)}
      </Card>
    </Screen>
  );
}
