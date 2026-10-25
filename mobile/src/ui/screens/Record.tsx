// Likho: every way a trade comes in. Ported from frontend/src/views/Record.tsx (Type tab).
// Voice (Bolo) and slip photos (Parchi) need the on-phone models; they are the next steps and say so.
import React, { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import type { Event, Source } from '../../core/events';
import { EntryRow, ledger, useNav } from '../common';
import { Body, Button, C, Card, ErrorLine, Muted, Pill, Row, Screen, Segmented, s } from '../kit';
import { t } from '../strings';

const EXAMPLES = [
  'Bhai 3 kilo tamatar liya 180 mein… Sharma ji ka 40 jama kar, aur 7 plate poha de.',
  'pandey ji ka 60 udhaar likh',
  '5 cup chai de',
  '2 peti kanda liya 300',
  'Rs.140 credited to your a/c XX1234 from CHHOTU via UPI',
  'aaj bahut garmi hai bhai',
];

type Mode = 'type' | 'voice' | 'slip';
type Result = { events: Event[]; unparsed: string[]; engine: string; fallback: string | null; normalized?: string };

export function Record() {
  const [mode, setMode] = useState<Mode>('type');
  return (
    <Screen title={t.record.title} line={t.record.line}>
      <Segmented value={mode} onChange={setMode} options={(['type', 'voice', 'slip'] as Mode[]).map((m) => ({ value: m, label: t.record.modes[m] }))} />
      {mode === 'type' && <TypeIt />}
      {mode === 'voice' && <Card><Body>{t.record.voiceSoon}</Body></Card>}
      {mode === 'slip' && <Card><Body>{t.record.slipSoon}</Body></Card>}
    </Screen>
  );
}

function TypeIt() {
  const nav = useNav();
  const [text, setText] = useState('');
  const [source, setSource] = useState<Source>('manual');
  const [engine, setEngine] = useState<'auto' | 'llm' | 'rules'>('auto');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await ledger().handleText(text.trim(), source, { engine });
      setResult({ events: r.events, unparsed: r.unparsed, engine: r.engine, fallback: r.fallback_reason, normalized: r.normalized_text });
      setText('');
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card title={t.record.what}>
        <TextInput
          style={[s.input, { minHeight: 120, textAlignVertical: 'top', paddingTop: 12 }]}
          multiline
          value={text}
          onChangeText={setText}
          placeholder={t.record.placeholder}
          placeholderTextColor={C.faint}
          accessibilityLabel={t.record.what}
        />
        <Button label={busy ? t.record.reading : t.record.add} onPress={submit} disabled={busy || !text.trim()} />
        <ErrorLine error={error} />
        <Text style={s.small}>{t.record.from}</Text>
        <Segmented value={source} onChange={setSource} options={(['manual', 'sms', 'tally', 'voice'] as Source[]).map((x) => ({ value: x, label: t.record.sources[x] }))} />
        <Text style={s.small}>{t.record.reader}</Text>
        <Segmented value={engine} onChange={setEngine} options={(['auto', 'llm', 'rules'] as const).map((x) => ({ value: x, label: t.record.readers[x] }))} />
      </Card>

      {result ? (
        <Card title={result.events.length ? t.record.booked(result.events.length, result.engine) : t.record.nothing(result.engine)} tone={result.events.length ? 'good' : undefined}>
          {result.normalized ? <Muted>{t.record.normalized(result.normalized)}</Muted> : null}
          {result.events.map((e) => {
            const flags = ((e.payload.flags as string[]) ?? []).filter((f) => t.record.flags[f]);
            return (
              <View key={e.id}>
                <EntryRow e={e} onPress={() => nav.push({ name: 'entry', id: e.id })} />
                {flags.length ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 6 }}>
                    {flags.map((f) => <Pill key={f}>{t.record.flags[f]}</Pill>)}
                  </View>
                ) : null}
              </View>
            );
          })}
          {result.unparsed.length ? <Text style={[s.body, { color: C.warn }]}>{t.record.unparsed}: “{result.unparsed.join('” · “')}”</Text> : null}
          {result.fallback ? <Muted>{t.record.fallback(result.fallback)}</Muted> : null}
        </Card>
      ) : null}

      <Card title={t.record.examples}>
        <Muted>{t.record.examplesNote}</Muted>
        {EXAMPLES.map((x) => (
          <Row key={x} onPress={() => setText(x)}>
            <Text style={[s.body, { flex: 1 }]}>{x}</Text>
            <Text style={{ color: C.faint, fontSize: 22 }}>›</Text>
          </Row>
        ))}
      </Card>
    </>
  );
}
