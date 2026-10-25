// Parivaar ke phones: this phone's identity, what it has seen, and each other phone's last sync.
// Ported from frontend/src/views/Devices.tsx. The phone-to-phone transport (hotspot) is the next step;
// until then the list of other phones is empty and the screen says so.
import React, { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { llm } from '../../app/llm';
import { service } from '../../app/service';
import { nameOf } from '../../core/identity';
import { ledger, useNav } from '../common';
import { Body, Button, C, Card, ErrorLine, Muted, Pill, Row, Screen, s, useLedgerVersion } from '../kit';
import { t } from '../strings';

export function Family() {
  const v = useLedgerVersion();
  const nav = useNav();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 2000); // "last synced N s ago" keeps moving
    return () => clearInterval(id);
  }, []);
  const st = useMemo(() => service.sync!.status(), [v, tick]);
  const frontier = useMemo(() => Object.entries(ledger().store.frontier()).sort(), [v]);
  const count = useMemo(() => ledger().store.all().length, [v]);
  const keySet = !!service.syncKey();

  async function syncNow() {
    setBusy(true);
    try {
      await service.sync!.runOnce();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setTick((x) => x + 1);
    }
  }

  return (
    <Screen title={t.family.title} onBack={nav.pop}>
      <Card title={t.family.thisPhone}>
        <Text style={[s.body, { fontWeight: '800', fontSize: 20 }]}>{st.name}</Text>
        <Text style={s.mono}>{st.actor}</Text>
        <Body>{t.family.entries(count)}</Body>
        <Body>{t.family.key}: <Text style={{ color: keySet ? C.good : C.warn, fontWeight: '700' }}>{keySet ? t.family.keySet : t.family.keyMissing}</Text></Body>
        {st.rotations.map((r: any) => <Text key={r.to} style={{ color: C.warn }}>{t.family.rotated(r.from, r.to, r.because)}</Text>)}
        <Text style={s.small}>{t.family.seen}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {frontier.map(([dev, n]) => <Pill key={dev} tone={dev === st.actor ? 'good' : 'muted'}>{`${nameOf(dev)} · ${n}`}</Pill>)}
        </View>
      </Card>
      <ModelCard />
      <Card title={t.family.peers}>
        {st.peers.length === 0 ? <Muted>{t.family.noPeers}</Muted> : st.peers.map((p) => (
          <Row key={p.url}>
            <View style={{ flex: 1 }}>
              <Text style={[s.body, { fontWeight: '700' }]}>{p.name ?? p.url}</Text>
              <Text style={s.mono}>{p.url}</Text>
              {p.lastError && p.state !== 'ok' ? <Text style={{ color: C.warn }}>{p.lastError}</Text> : null}
              {p.warnings.map((w) => <Text key={w} style={{ color: C.warn }}>{w}</Text>)}
            </View>
            <Text style={{ color: p.state === 'ok' ? C.good : C.warn, maxWidth: 150, textAlign: 'right' }}>
              {p.state === 'ok' ? t.family.ok(t.secondsAgo(p.lastOkSAgo ?? 0)) : p.state === 'unreachable' ? t.family.away(p.failuresInARow) : p.state === 'refused' ? t.family.refused : p.state === 'error' ? t.family.error : t.family.never}
            </Text>
          </Row>
        ))}
        <Button kind="plain" label={t.family.syncNow} disabled={busy || st.peers.length === 0} onPress={syncNow} />
        <ErrorLine error={error} />
      </Card>
    </Screen>
  );
}

/** The on-phone language model: state, file, load time and the last answer's speed (measured, not guessed). */
function ModelCard() {
  const [st, setSt] = useState(llm.status);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => llm.subscribe(() => setSt(llm.status)), []);
  return (
    <Card title={t.family.model} tone={st.state === 'error' ? 'bad' : st.state === 'ready' ? 'good' : undefined}>
      <Body style={{ fontWeight: '700' }}>{t.family.modelStates[st.state]}</Body>
      <Text style={s.mono}>{st.file}</Text>
      {st.loadSeconds != null ? <Muted>{t.family.modelLoad(st.loadSeconds)}</Muted> : null}
      {st.last ? <Muted>{t.family.modelLast(st.last.promptTokens, st.last.promptSeconds, st.last.outTokens, st.last.outSeconds)}</Muted> : null}
      {st.error ? <Text style={{ color: C.bad }}>{st.error}</Text> : null}
      {st.state !== 'ready' ? <Button kind="plain" label={t.family.modelStart} disabled={st.state === 'loading'} onPress={() => llm.load().then(() => setError(null), (e) => setError((e as Error).message))} /> : null}
      <ErrorLine error={error} />
    </Card>
  );
}
