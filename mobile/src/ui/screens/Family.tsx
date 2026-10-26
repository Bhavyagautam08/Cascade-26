// Parivaar ke phones: join the family's phones without typing addresses. Each phone runs the sync server;
// "Phone dhoondo" asks every address on this phone's Wi-Fi / hotspot and keeps the ones with the same family
// key. Offline: no internet, no cloud. Ported from frontend/src/views/Devices.tsx.
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { llm } from '../../app/llm';
import { service } from '../../app/service';
import { syncPort } from '../../app/syncTcp';
import { nameOf } from '../../core/identity';
import { ledger, useNav } from '../common';
import { Body, Button, C, Card, ErrorLine, Field, Input, More, Muted, Pill, Row, Screen, s, useLedgerVersion } from '../kit';
import { t } from '../strings';

export function Family() {
  useLedgerVersion();
  const nav = useNav();
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [keyDraft, setKeyDraft] = useState(service.syncKey());
  const [keySaved, setKeySaved] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 2000); // "last synced N s ago" keeps moving
    return () => clearInterval(id);
  }, []);
  const st = service.sync!.status();
  const frontier = Object.entries(ledger().store.frontier()).sort();
  const count = ledger().store.all().length;
  const addresses = service.peerAddresses();
  const disc = service.discovery;
  const wrongKey = disc.found.filter((f) => !f.keyOk);
  const joined = disc.found.filter((f) => f.keyOk);

  async function find() {
    setError(null);
    try {
      await service.findPhones();
    } catch (e) {
      setError((e as Error).message);
    }
  }

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
      <Card title={t.family.pairTitle} tone="good">
        {t.family.steps.map((line) => <Body key={line}>{line}</Body>)}
        <Field label={t.family.key}>
          <Input secret value={keyDraft} onChangeText={(value) => { setKeyDraft(value); setKeySaved(false); }} accessibilityLabel={t.family.key} />
        </Field>
        {keyDraft.trim() !== service.syncKey() ? (
          <Button small kind="soft" label={t.family.saveKey} onPress={() => {
            service.setSyncKey(keyDraft);
            setKeySaved(true);
            setError(null);
          }} />
        ) : null}
        {keySaved ? <Muted>{t.family.keySaved}</Muted> : null}
        <Button icon="🔍" label={disc.scanning ? t.family.finding(disc.done, disc.total) : t.family.find} onPress={find} disabled={disc.scanning || !service.syncKey()} />
        {!service.syncKey() ? <Text style={{ color: C.warn }}>{t.family.key}: {t.family.keyMissing}</Text> : null}
        {!disc.scanning && disc.at ? (
          <>
            {joined.map((f) => <Body key={f.url} style={{ color: C.good, fontWeight: '700' }}>{t.family.foundOk(f.name)}</Body>)}
            {wrongKey.length ? <Text style={[s.body, { color: C.warn }]}>{t.family.foundWrongKey}</Text> : null}
            {!disc.found.length && !disc.error ? <Text style={[s.body, { color: C.warn }]}>{t.family.foundNone}</Text> : null}
            <Text style={s.small}>{t.family.foundAt(t.secondsAgo((Date.now() - disc.at) / 1000))}</Text>
          </>
        ) : null}
        <ErrorLine error={error ?? disc.error} />
        <Muted>{t.family.auto}</Muted>
      </Card>

      <Card title={t.family.peers}>
        {addresses.length === 0 ? <Muted>{t.family.noPeers}</Muted> : addresses.map((url) => {
          const p = st.peers.find((peer) => peer.url === url);
          return (
            <Row key={url}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[s.body, { fontWeight: '800' }]}>📱 {p?.name ?? url}</Text>
                <Text style={{ color: p?.state === 'ok' ? C.good : C.warn, fontWeight: '700' }}>
                  {!p ? t.family.never : p.state === 'ok' ? t.family.ok(t.secondsAgo(p.lastOkSAgo ?? 0)) : p.state === 'unreachable' ? t.family.away(p.failuresInARow) : p.state === 'refused' ? t.family.refused : p.state === 'error' ? t.family.error : t.family.never}
                </Text>
                {p?.lastError && p.state !== 'ok' ? <Text style={s.small}>{p.lastError}</Text> : null}
                {p?.warnings.map((w) => <Text key={w} style={{ color: C.warn }}>{w}</Text>)}
              </View>
              <Button kind="plain" small label={t.family.removePeer} onPress={() => service.removePeerAddress(url)} />
            </Row>
          );
        })}
        <Button icon="🔄" kind="soft" label={t.family.syncNow} disabled={busy || st.peers.length === 0} onPress={syncNow} />
      </Card>

      <Card title={t.family.thisPhone}>
        <Text style={[s.body, { fontWeight: '800', fontSize: 20 }]}>{st.name}</Text>
        <Body>{t.family.entries(count)}</Body>
        {st.rotations.map((r: any) => <Text key={r.to} style={{ color: C.warn }}>{t.family.rotated(r.from, r.to, r.because)}</Text>)}
        <More label={t.family.advanced}>
          <Text style={s.mono}>{st.actor}</Text>
          <Body>
            {service.syncServerState === 'listening' ? t.family.serverListening(syncPort)
              : service.syncServerState === 'starting' ? t.family.serverStarting
                : service.syncServerState === 'error' ? t.family.serverError(service.syncServerError ?? 'unknown error')
                  : t.family.serverStopped}
          </Body>
          <Text style={s.small}>{t.family.seen}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {frontier.map(([dev, n]) => <Pill key={dev} tone={dev === st.actor ? 'good' : 'muted'}>{`${nameOf(dev)} · ${n}`}</Pill>)}
          </View>
          <Muted>{t.family.peerHint}</Muted>
          <Input value={address} onChangeText={setAddress} placeholder={t.family.peerAddress} autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation" accessibilityLabel={t.family.peerAddress} />
          <Button kind="plain" small label={t.family.addPeer} disabled={!address.trim()} onPress={() => {
            try {
              service.addPeerAddress(address);
              setAddress('');
              setError(null);
            } catch (e) {
              setError((e as Error).message);
            }
          }} />
          {addresses.map((url) => <Text key={url} style={s.mono}>{url}</Text>)}
        </More>
      </Card>
      <ModelCard />
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
      {st.device ? <Muted>{st.device}</Muted> : null}
      {st.loadSeconds != null ? <Muted>{t.family.modelLoad(st.loadSeconds)}</Muted> : null}
      {st.last ? <Muted>{t.family.modelLast(st.last.promptTokens, st.last.promptSeconds, st.last.outTokens, st.last.outSeconds)}</Muted> : null}
      {st.error ? <Text style={{ color: C.bad }}>{st.error}</Text> : null}
      {st.state !== 'ready' ? <Button kind="plain" label={t.family.modelStart} disabled={st.state === 'loading'} onPress={() => llm.load().then(() => setError(null), (e) => setError((e as Error).message))} /> : null}
      <More label={t.family.advanced}>
        <Text style={s.mono}>{st.file}</Text>
      </More>
      <ErrorLine error={error} />
    </Card>
  );
}
