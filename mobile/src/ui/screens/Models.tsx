// Models: the one-time download that slips and voice need. Everything else works without it.
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { downloads, MODELS, totalBytes } from '../../app/models';
import { useNav } from '../common';
import { Body, Button, C, Card, ErrorLine, Muted, Screen, s } from '../kit';
import { t } from '../strings';

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);

export function useDownloads() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const off = downloads.subscribe(() => setTick((x) => x + 1));
    void downloads.refresh();
    return off;
  }, []);
  return downloads;
}

export function Models() {
  const nav = useNav();
  const d = useDownloads();
  const done = MODELS.reduce((x, m) => x + (d.states[m.id]?.bytes ?? 0), 0);
  const ready = d.allReady();
  return (
    <Screen title={t.models.title} line={t.models.line(mb(totalBytes))} onBack={nav.pop}>
      <Card tone={ready ? 'good' : 'warn'}>
        {ready ? <Body style={{ color: C.good, fontWeight: '800' }}>{t.models.allReady}</Body> : (
          <>
            {t.models.notes.map((n) => <Body key={n}>• {n}</Body>)}
            <Bar value={done / totalBytes} />
            <Text style={s.small}>{t.models.progress(mb(done), mb(totalBytes))}</Text>
            {d.running
              ? <Button kind="plain" icon="⏸" label={t.models.pause} onPress={() => d.pause()} />
              : <Button icon="⬇️" label={done > 0 ? t.models.resume : t.models.start} onPress={() => void d.downloadAll()} />}
          </>
        )}
      </Card>
      <Card title={t.models.files}>
        {MODELS.map((m) => {
          const st = d.states[m.id];
          return (
            <View key={m.id} style={[s.row, { flexDirection: 'column', alignItems: 'stretch', gap: 4 }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={[s.body, { fontWeight: '700', flex: 1 }]}>{m.for}</Text>
                <Text style={[s.body, { color: st?.present ? C.good : C.muted }]}>{st ? t.models.states[st.state] : '…'}</Text>
              </View>
              <Muted>{m.file} · {mb(m.size)}</Muted>
              {!st?.present && st ? <Bar value={st.bytes / m.size} /> : null}
              <ErrorLine error={st?.error ?? null} />
            </View>
          );
        })}
      </Card>
    </Screen>
  );
}

function Bar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <View style={{ height: 12, borderRadius: 6, backgroundColor: '#E8E4DA', overflow: 'hidden' }}>
      <View style={{ width: `${pct}%`, height: '100%', backgroundColor: C.brand }} />
    </View>
  );
}
