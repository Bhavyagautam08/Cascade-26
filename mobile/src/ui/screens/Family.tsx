// Parivaar ke phones: this phone's identity, what it has seen, and each other phone's last sync.
// Ported from frontend/src/views/Devices.tsx; phones connect over the local TCP sync transport.
import React, { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { llm } from '../../app/llm';
import { service } from '../../app/service';
import { syncPort } from '../../app/syncTcp';
import { nameOf } from '../../core/identity';
import { ledger, useNav } from '../common';
import { Body, Button, C, Card, ErrorLine, Muted, Pill, Row, Screen, s, useLedgerVersion } from '../kit';
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
  const keySet = !!service.syncKey();
  const addresses = service.peerAddresses();

  function addPeer() {
    try {
      service.addPeerAddress(address);
      setAddress('');
      setError(null);
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
        <Body>
          {service.syncServerState === 'listening' ? t.family.serverListening(syncPort)
            : service.syncServerState === 'starting' ? t.family.serverStarting
              : service.syncServerState === 'error' ? t.family.serverError(service.syncServerError ?? 'unknown error')
                : t.family.serverStopped}
        </Body>
        <Muted>{t.family.peerHint}</Muted>
        <Text style={s.body}>{t.family.keyEdit}</Text>
        <TextInput
          style={s.input}
          value={keyDraft}
          onChangeText={(value) => { setKeyDraft(value); setKeySaved(false); }}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          accessibilityLabel={t.family.keyEdit}
        />
        <Button kind="plain" label={t.family.saveKey} onPress={() => {
          service.setSyncKey(keyDraft);
          setKeySaved(true);
          setError(null);
        }} />
        {keySaved ? <Muted>{t.family.keySaved}</Muted> : null}
        <TextInput
          style={s.input}
          value={address}
          onChangeText={setAddress}
          placeholder={t.family.peerAddress}
          placeholderTextColor={C.faint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
          accessibilityLabel={t.family.peerAddress}
        />
        <Button kind="plain" label={t.family.addPeer} disabled={!address.trim()} onPress={addPeer} />
        {addresses.length === 0 ? <Muted>{t.family.noPeers}</Muted> : addresses.map((url) => {
          const p = st.peers.find((peer) => peer.url === url);
          return (
          <Row key={url}>
            <View style={{ flex: 1 }}>
              <Text style={[s.body, { fontWeight: '700' }]}>{p?.name ?? url}</Text>
              <Text style={s.mono}>{url}</Text>
              {p?.lastError && p.state !== 'ok' ? <Text style={{ color: C.warn }}>{p.lastError}</Text> : null}
              {p?.warnings.map((w) => <Text key={w} style={{ color: C.warn }}>{w}</Text>)}
            </View>
            {p ? <Text style={{ color: p.state === 'ok' ? C.good : C.warn, maxWidth: 150, textAlign: 'right' }}>
              {p.state === 'ok' ? t.family.ok(t.secondsAgo(p.lastOkSAgo ?? 0)) : p.state === 'unreachable' ? t.family.away(p.failuresInARow) : p.state === 'refused' ? t.family.refused : p.state === 'error' ? t.family.error : t.family.never}
            </Text> : null}
            <Button kind="danger" small label={t.family.removePeer} onPress={() => service.removePeerAddress(url)} />
          </Row>
          );
        })}
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
