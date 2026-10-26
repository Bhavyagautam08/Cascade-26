// Likho: every way a trade comes in. Ported from frontend/src/views/Record.tsx.
// Likho (type), Bolo (the always-on mic + one recorded trade), Parchi (slip photo). Bolo's single recording
// and Parchi are shown for review before anything is written to the ledger.
import { launchCamera, launchImageLibrary, type Asset } from 'react-native-image-picker';
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Image, Linking, Text, View } from 'react-native';
import { llm } from '../../app/llm';
import { clipRecorder, MicBlocked } from '../../app/mic';
import { readSlipPhoto } from '../../app/slipReader';
import type { Event, Source } from '../../core/events';
import { checkSlipConsistency, type Slip } from '../../core/slip';
import type { SpellingFix } from '../../core/spelling';
import { AskKind, EntryRow, MicPanel, confirmRemove, itemKey, itemName, ledger, useClip, useNav } from '../common';
import { Actions, Body, Button, C, Card, ErrorLine, Field, Input, LevelMeter, MicButton, More, Muted, Pill, Row, Screen, Segmented, s } from '../kit';
import { t } from '../strings';

// sentence shapes the reader understands (no real customers: a name is shown as "Ramesh" only as an example)
const EXAMPLES = [
  '3 kilo tamatar liya 180 mein, aur 2 kilo aloo liya 60 mein',
  'Ramesh ka 60 udhaar likh',
  'Ramesh ka 40 jama kar',
  '5 cup chai becha 50 mein',
  'aaj bahut garmi hai bhai',
];

type Mode = 'type' | 'voice' | 'slip';
type Result = { text: string; source: Source; events: Event[]; unparsed: string[]; engine: string; fallback: string | null; normalized?: string; spelling: SpellingFix[] };
type SlipDraftLine = { item: string; readAs: string | null; qty: string; unit: string; amount: string; confidence: number; text: string; notes: string[] };
type SlipDraft = { supplier: string; total: string; rotation: number; text: string; warnings: string[]; lines: SlipDraftLine[] };
const MAX_CLIP_SECONDS = 60;

export function Record() {
  const [mode, setMode] = useState<Mode>('type');
  return (
    <Screen title={t.record.title} line={t.record.line}>
      <Segmented value={mode} onChange={setMode} options={([['type', '⌨️'], ['voice', '🎙️'], ['slip', '🧾']] as [Mode, string][]).map(([m, icon]) => ({ value: m, label: `${icon} ${t.record.modes[m]}` }))} />
      {mode === 'type' && <TypeIt />}
      {mode === 'voice' && <VoiceIt />}
      {mode === 'slip' && <SlipIt />}
    </Screen>
  );
}

/** What was just booked, each with ✎ / 🗑 right there, plus how the words were read. */
function Booked({ result, onRemoved, onBooked }: { result: Result; onRemoved: (id: string) => void; onBooked: (events: Event[]) => void }) {
  const nav = useNav();
  const [error, setError] = useState<string | null>(null);
  const engine = t.record.engines[result.engine] ?? result.engine;
  return (
    <Card title={result.events.length ? t.record.booked(result.events.length, engine) : t.record.nothing(engine)} tone={result.events.length ? 'good' : undefined}>
      {result.spelling.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {result.spelling.map((f) => <Pill key={`${f.from}-${f.to}`}>{t.record.spelling(f.from, f.to)}</Pill>)}
        </View>
      ) : null}
      {result.normalized ? <Muted>{t.record.normalized(result.normalized)}</Muted> : null}
      {result.events.map((e) => {
        const flags = ((e.payload.flags as string[]) ?? []).filter((f) => t.record.flags[f]);
        return (
          <View key={e.id} style={{ gap: 6 }}>
            <EntryRow e={e} onPress={() => nav.push({ name: 'entry', id: e.id })} />
            {flags.length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {flags.map((f) => <Pill key={f}>{t.record.flags[f]}</Pill>)}
              </View>
            ) : null}
            <Actions>
              <Button small kind="soft" icon="✎" label={t.review.edit} onPress={() => nav.push({ name: 'entry', id: e.id, edit: true })} />
              <Button small kind="plain" icon="🗑" label={t.review.remove} onPress={() => confirmRemove(e, setError, () => onRemoved(e.id))} />
            </Actions>
          </View>
        );
      })}
      {result.unparsed.length ? <Text style={[s.body, { color: C.warn }]}>{t.record.unparsed}: “{result.unparsed.join('” · “')}”</Text> : null}
      {result.fallback ? <Muted>{t.record.fallback(result.fallback)}</Muted> : null}
      {!result.events.length ? <AskKind text={result.text} source={result.source} onBooked={(ids) => onBooked(ids.map((id) => ledger().store.get(id)).filter((e): e is Event => !!e))} /> : null}
      <ErrorLine error={error} />
    </Card>
  );
}

function asResult(r: Awaited<ReturnType<ReturnType<typeof ledger>['handleText']>>, text: string, source: Source): Result {
  return { text, source, events: r.events, unparsed: r.unparsed, engine: r.engine, fallback: r.fallback_reason, normalized: r.normalized_text, spelling: r.spelling };
}

function asDraft(slip: Slip): SlipDraft {
  return {
    supplier: slip.supplier ?? '',
    total: slip.total_rupees === null ? '' : String(slip.total_rupees),
    rotation: slip.rotation,
    text: slip.text,
    warnings: slip.warnings,
    lines: slip.lines.map((line) => {
      const matched = line.notes.map((n) => /read as '(.+?)', matched '(.+?)'/.exec(n)).find(Boolean);
      return {
        item: itemName(line.item),
        readAs: matched ? matched[1] : null,
        qty: line.qty === null ? '' : String(line.qty),
        unit: line.unit ?? '',
        amount: line.amount_rupees === null ? '' : String(line.amount_rupees),
        confidence: line.confidence,
        text: line.text,
        notes: line.notes.filter((n) => !/read as '/.test(n)),
      };
    }),
  };
}

function numericField(value: string, name: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} mein 0 ya usse zyada number likhiye`);
  return number;
}

const emptyLine = (): SlipDraftLine => ({ item: '', readAs: null, qty: '', unit: '', amount: '', confidence: 1, text: '', notes: [] });

function SlipIt() {
  const [photo, setPhoto] = useState<string | null>(null);
  const [draft, setDraft] = useState<SlipDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setSeconds(0);
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  async function choosePhoto(camera: boolean) {
    setError(null);
    setSaved(null);
    try {
      const response = camera
        ? await launchCamera({ mediaType: 'photo', cameraType: 'back', saveToPhotos: false, maxWidth: 1600, maxHeight: 1600, quality: 0.9 })
        : await launchImageLibrary({ mediaType: 'photo', selectionLimit: 1, maxWidth: 1600, maxHeight: 1600, quality: 0.9 });
      if (response.didCancel) return;
      if (response.errorCode) throw new Error(response.errorMessage ?? response.errorCode);
      const asset: Asset | undefined = response.assets?.[0];
      if (!asset?.uri) throw new Error('photo picker did not return an image');
      setPhoto(asset.uri);
      setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function readSlip() {
    if (!photo) return;
    setBusy(true);
    stopped.current = false;
    setError(null);
    setSaved(null);
    try {
      const slip = await readSlipPhoto(photo, ledger().lexicon.data, () => stopped.current);
      const draft = asDraft(slip);
      setDraft(draft.lines.length ? draft : { ...draft, lines: [emptyLine()] });
    } catch (e) {
      console.error('Parchi photo reading failed', e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function updateLine(index: number, changes: Partial<SlipDraftLine>) {
    setDraft((current) => current ? ({
      ...current,
      lines: current.lines.map((line, i) => i === index ? { ...line, ...changes } : line),
    }) : current);
  }

  function saveSlip() {
    if (!draft) return;
    try {
      const total = numericField(draft.total, t.record.slipTotal);
      const slip = checkSlipConsistency({
        supplier: draft.supplier.trim() || null,
        total_rupees: total,
        rotation: draft.rotation,
        text: draft.text,
        warnings: [],
        lines: draft.lines.map((line) => ({
          item: itemKey(line.item) ?? '',
          qty: numericField(line.qty, t.record.slipQty),
          unit: line.unit.trim() || null,
          amount_rupees: numericField(line.amount, t.record.slipPrice),
          confidence: 1, // the vendor checked every line before saving
          text: line.text,
          notes: line.notes,
        })),
      });
      if (!slip.lines.length || slip.lines.some((line) => !line.item || line.item === '?')) {
        throw new Error('har item ka naam dekh kar sahi karein, phir save karein');
      }
      const events = ledger().record(slip.lines.map((line) => ({
        kind: 'purchase',
        source: 'slip',
        confidence: line.confidence,
        item: line.item,
        qty: line.qty,
        unit: line.unit,
        amount_rupees: line.amount_rupees,
        party: slip.supplier,
        raw: line.text || null,
      })));
      setDraft(null);
      setPhoto(null);
      setSaved(events.length);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Card title={t.record.slipTitle}>
        <Muted>{t.record.slipNote}</Muted>
        {llm.status.notice ? <Text style={[s.body, { color: C.warn }]}>{llm.status.notice}</Text> : null}
        <Actions>
          <Button icon="📷" label={t.record.slipCamera} onPress={() => choosePhoto(true)} disabled={busy} />
          <Button icon="🖼️" label={t.record.slipGallery} kind="plain" onPress={() => choosePhoto(false)} disabled={busy} />
        </Actions>
        {photo ? <Image source={{ uri: photo }} resizeMode="contain" style={{ width: '100%', height: 220, marginTop: 8 }} accessibilityLabel={t.record.slipPhoto} /> : null}
        {photo && !draft ? <Button label={busy ? t.record.slipReading(seconds) : t.record.slipRead} onPress={readSlip} disabled={busy} /> : null}
        {busy ? (
          <>
            <Muted>{t.record.slipSlow}</Muted>
            <Button kind="warn" label={t.record.slipStop} onPress={() => { stopped.current = true; void llm.stop(); }} />
          </>
        ) : null}
        {!draft && !busy ? <Button small kind="plain" icon="✎" label={t.record.slipManual} onPress={() => setDraft({ supplier: '', total: '', rotation: 0, text: '', warnings: [], lines: [emptyLine()] })} /> : null}
        <ErrorLine error={error} />
        {saved !== null ? <Body style={{ color: C.good, fontWeight: '700' }}>✓ {t.record.slipSaved(saved)}</Body> : null}
      </Card>

      {draft ? (
        <Card title={t.record.slipReview} tone={draft.warnings.length ? 'warn' : undefined}>
          {draft.warnings.map((warning) => <Text key={warning} style={[s.body, { color: C.warn }]}>{warning}</Text>)}
          <Field label={t.record.slipSupplier}><Input value={draft.supplier} onChangeText={(supplier) => setDraft({ ...draft, supplier })} placeholder={t.record.slipSupplier} /></Field>
          <Field label={t.record.slipTotal}><Input value={draft.total} onChangeText={(total) => setDraft({ ...draft, total })} keyboardType="decimal-pad" placeholder="0" /></Field>
          {draft.lines.map((line, index) => (
            <View key={index} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingTop: 12, marginTop: 6, gap: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={[s.small, line.confidence < 0.6 ? { color: C.warn } : null]}>{t.record.slipConfidence(Math.round(line.confidence * 100))}</Text>
                {line.notes.length || line.confidence < 0.6 ? <Pill>{t.record.slipCheck}</Pill> : null}
              </View>
              {line.text ? <Muted>{line.text}</Muted> : null}
              <Field label={t.record.slipItem}><Input value={line.item} onChangeText={(item) => updateLine(index, { item, readAs: null })} placeholder={t.record.slipItem} /></Field>
              {line.readAs ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Pill>{t.record.spelling(line.readAs, line.item)}</Pill>
                  <Button small kind="plain" label={t.record.slipUndo(line.readAs)} onPress={() => updateLine(index, { item: line.readAs!, readAs: null })} />
                </View>
              ) : null}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Field label={t.record.slipQty}><Input value={line.qty} onChangeText={(qty) => updateLine(index, { qty })} keyboardType="decimal-pad" placeholder="0" /></Field>
                <Field label={t.record.slipUnit}><Input value={line.unit} onChangeText={(unit) => updateLine(index, { unit })} placeholder="kg" /></Field>
                <Field label={t.record.slipPrice}><Input value={line.amount} onChangeText={(amount) => updateLine(index, { amount })} keyboardType="decimal-pad" placeholder="₹" /></Field>
              </View>
              {line.notes.map((note) => <Muted key={note}>{note}</Muted>)}
              <Button small kind="plain" icon="🗑" label={t.stock.removeItem} onPress={() => setDraft({ ...draft, lines: draft.lines.filter((_, i) => i !== index) })} />
            </View>
          ))}
          <Button kind="plain" icon="＋" label={t.record.slipAddLine} onPress={() => setDraft({ ...draft, lines: [...draft.lines, emptyLine()] })} />
          <Button icon="✓" label={t.record.slipConfirm} onPress={saveSlip} disabled={busy || !draft.lines.length || draft.lines.some((line) => !line.item.trim() || line.item === '?')} />
          <Button label={t.record.slipDiscard} kind="plain" onPress={() => setDraft(null)} disabled={busy} />
        </Card>
      ) : null}
    </>
  );
}

function VoiceIt() {
  const clip = useClip();
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  async function stopAndRead() {
    if (!clipRecorder.active) return;
    setBusy(true);
    setError(null);
    try {
      setTranscript(await clipRecorder.stopAndRead(ledger()));
      setResult(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (clip.active && clip.seconds >= MAX_CLIP_SECONDS) void stopAndRead();
  }, [clip.active, clip.seconds]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // leaving the app ends a single recording (the always-on mic keeps going on its own)
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && clipRecorder.active) void stopAndRead();
    });
    return () => sub.remove();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function startRecording() {
    setError(null);
    setResult(null);
    setTranscript('');
    try {
      await clipRecorder.start();
      setBlocked(false);
    } catch (e) {
      setBlocked(e instanceof MicBlocked);
      setError((e as Error).message);
    }
  }

  async function bookTranscript() {
    if (!transcript.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(asResult(await ledger().handleText(transcript.trim(), 'voice'), transcript.trim(), 'voice'));
      setTranscript('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <MicPanel />
      <Card title={t.record1.title}>
        <Muted>{t.record1.note}</Muted>
        <MicButton on={clip.active} busy={busy} onPress={clip.active ? stopAndRead : startRecording} label={clip.active ? t.record1.stop(Math.floor(clip.seconds)) : busy ? t.record1.reading : t.record1.start} />
        {clip.active ? (
          <>
            <LevelMeter level={clip.level} on />
            <Button small kind="plain" label={t.cancel} onPress={() => void clipRecorder.cancel()} />
          </>
        ) : null}
        <ErrorLine error={error} />
        {blocked ? <Button kind="warn" label={t.mic.openSettings} onPress={() => void Linking.openSettings()} /> : null}
        {busy ? <Muted>{t.record.voiceProgress}</Muted> : null}
        {transcript ? (
          <>
            <Text style={s.label}>{t.record.voiceHeard}</Text>
            <Input style={{ minHeight: 100, textAlignVertical: 'top', paddingTop: 12 }} multiline value={transcript} onChangeText={setTranscript} accessibilityLabel={t.record.voiceHeard} />
            <Button icon="✓" label={t.record.voiceBook} onPress={bookTranscript} disabled={busy || !transcript.trim()} />
            <Button kind="plain" label={t.record.voiceDiscard} onPress={() => setTranscript('')} disabled={busy} />
          </>
        ) : null}
      </Card>
      {result ? <Booked result={result} onRemoved={(id) => setResult({ ...result, events: result.events.filter((e) => e.id !== id) })} onBooked={(events) => setResult({ ...result, events })} /> : null}
    </>
  );
}

function TypeIt() {
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
      setResult(asResult(await ledger().handleText(text.trim(), source, { engine }), text.trim(), source));
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
        <Input style={{ minHeight: 120, textAlignVertical: 'top', paddingTop: 12 }} multiline value={text} onChangeText={setText} placeholder={t.record.placeholder} accessibilityLabel={t.record.what} />
        <Button icon="＋" label={busy ? t.record.reading : t.record.add} onPress={submit} disabled={busy || !text.trim()} />
        <ErrorLine error={error} />
        <More label={t.record.options}>
          <Text style={s.label}>{t.record.from}</Text>
          <Segmented value={source} onChange={setSource} options={(['manual', 'sms', 'tally', 'voice'] as Source[]).map((x) => ({ value: x, label: t.record.sources[x] }))} />
          <Text style={s.label}>{t.record.reader}</Text>
          <Segmented value={engine} onChange={setEngine} options={(['auto', 'llm', 'rules'] as const).map((x) => ({ value: x, label: t.record.readers[x] }))} />
        </More>
      </Card>

      {result ? <Booked result={result} onRemoved={(id) => setResult({ ...result, events: result.events.filter((e) => e.id !== id) })} onBooked={(events) => setResult({ ...result, events })} /> : null}

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
