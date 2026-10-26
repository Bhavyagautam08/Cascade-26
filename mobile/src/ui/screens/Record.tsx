// Likho: every way a trade comes in. Ported from frontend/src/views/Record.tsx (Type tab).
// Bolo and Parchi both require review before any recognized text is written to the ledger.
import ImageResizer from '@bam.tech/react-native-image-resizer';
import LiveAudioStream from '@fugood/react-native-audio-pcm-stream';
import { launchCamera, launchImageLibrary, type Asset } from 'react-native-image-picker';
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Image, Linking, PermissionsAndroid, Text, TextInput, View } from 'react-native';
import { files } from '../../app/files';
import { llm } from '../../app/llm';
import { transcribeVoice } from '../../app/voice';
import type { Event, Source } from '../../core/events';
import { checkSlipConsistency, lineConfidences, normalizeSlip, parseSlip, type Slip } from '../../core/slip';
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
type SlipDraftLine = { item: string; qty: string; unit: string; amount: string; confidence: number; text: string; notes: string[] };
type SlipDraft = { supplier: string; total: string; rotation: number; text: string; warnings: string[]; lines: SlipDraftLine[] };
const SLIP_READ_TOKENS = 512;

export function Record() {
  const [mode, setMode] = useState<Mode>('type');
  return (
    <Screen title={t.record.title} line={t.record.line}>
      <Segmented value={mode} onChange={setMode} options={(['type', 'voice', 'slip'] as Mode[]).map((m) => ({ value: m, label: t.record.modes[m] }))} />
      {mode === 'type' && <TypeIt />}
      {mode === 'voice' && <VoiceIt />}
      {mode === 'slip' && <SlipIt />}
    </Screen>
  );
}

function asDraft(slip: Slip): SlipDraft {
  return {
    supplier: slip.supplier ?? '',
    total: slip.total_rupees === null ? '' : String(slip.total_rupees),
    rotation: slip.rotation,
    text: slip.text,
    warnings: slip.warnings,
    lines: slip.lines.map((line) => ({
      item: line.item,
      qty: line.qty === null ? '' : String(line.qty),
      unit: line.unit ?? '',
      amount: line.amount_rupees === null ? '' : String(line.amount_rupees),
      confidence: line.confidence,
      text: line.text,
      notes: line.notes,
    })),
  };
}

function imagePath(path: string): string {
  return path.startsWith('file://') ? path.slice(7) : path;
}

async function makeSlipImage(uri: string, degreesCounterClockwise: number, size: number): Promise<string> {
  const image = await ImageResizer.createResizedImage(uri, size, size, 'JPEG', 90, -degreesCounterClockwise, null, false, { onlyScaleDown: true });
  return image.path;
}

async function removeTempImage(path: string) {
  const deleted = await files.deleteFile(imagePath(path));
  if (!deleted) console.warn(`could not delete temporary slip image: ${path}`);
}

function numericField(value: string, name: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} should be a non-negative number`);
  return number;
}

function SlipIt() {
  const [photo, setPhoto] = useState<string | null>(null);
  const [draft, setDraft] = useState<SlipDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

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
    setError(null);
    setSaved(null);
    try {
      const path = await makeSlipImage(photo, 0, 1280);
      let answer;
      try {
        answer = await llm.image(path, SLIP_READ_TOKENS, 1);
      } finally {
        await removeTempImage(path);
      }
      const textLines = answer.content.split('\n');
      const parsed = parseSlip(textLines);
      if (!parsed.lines.length) throw new Error('photo se koi item line nahi padh paaya; roshni/saaf photo ke saath phir koshish karein');
      const confidence = lineConfidences(answer.content, answer.probabilities);
      const warnings = ['photo orientation is not auto-detected; check that the reviewed lines match the photo'];
      if (answer.truncated) warnings.push('Qwen stopped at its output limit; some lines may be missing. Add any missing items and check every row before saving.');
      const slip = normalizeSlip(checkSlipConsistency({
        supplier: parsed.supplier,
        lines: parsed.lines.map(({ index, line }) => ({
          item: line.item ?? '?',
          qty: line.qty,
          unit: line.unit,
          amount_rupees: line.amount_rupees,
          confidence: line.item ? (confidence[index] ?? 0.5) : 0.5,
          text: textLines[index]?.trim() ?? '',
          notes: line.item ? line.notes : [...line.notes, 'item not clear; correct before saving'],
        })),
        total_rupees: parsed.total_rupees,
        rotation: 0,
        text: answer.content.trim(),
        warnings,
      }), ledger().lexicon.data);
      setDraft(asDraft(slip));
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

  function addSlipLine() {
    setDraft((current) => current ? ({
      ...current,
      lines: [...current.lines, {
        item: '',
        qty: '',
        unit: '',
        amount: '',
        confidence: 0.5,
        text: '',
        notes: ['manually added; copy from the slip'],
      }],
    }) : current);
  }

  function saveSlip() {
    if (!draft) return;
    try {
      const total = numericField(draft.total, 'total');
      const slip = checkSlipConsistency({
        supplier: draft.supplier.trim() || null,
        total_rupees: total,
        rotation: draft.rotation,
        text: draft.text,
        warnings: [],
        lines: draft.lines.map((line) => ({
          item: line.item.trim(),
          qty: numericField(line.qty, 'quantity'),
          unit: line.unit.trim() || null,
          amount_rupees: numericField(line.amount, 'price'),
          confidence: line.confidence,
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
        raw: line.text,
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
        <Button label={t.record.slipCamera} onPress={() => choosePhoto(true)} disabled={busy} />
        <Button label={t.record.slipGallery} kind="plain" onPress={() => choosePhoto(false)} disabled={busy} />
        {photo ? <Image source={{ uri: photo }} resizeMode="contain" style={{ width: '100%', height: 220, marginTop: 8 }} accessibilityLabel={t.record.slipPhoto} /> : null}
        {photo && !draft ? <Button label={busy ? t.record.slipReading : t.record.slipRead} onPress={readSlip} disabled={busy} /> : null}
        <ErrorLine error={error} />
        {saved !== null ? <Body style={{ color: C.good }}>{t.record.slipSaved(saved)}</Body> : null}
      </Card>

      {draft ? (
        <Card title={t.record.slipReview} tone={draft.warnings.length ? 'warn' : undefined}>
          <Muted>{t.record.slipRotation(draft.rotation)}</Muted>
          {draft.warnings.map((warning) => <Text key={warning} style={[s.body, { color: C.warn }]}>{warning}</Text>)}
          <Text style={s.small}>{t.record.slipSupplier}</Text>
          <TextInput style={s.input} value={draft.supplier} onChangeText={(supplier) => setDraft({ ...draft, supplier })} placeholder={t.record.slipSupplier} placeholderTextColor={C.faint} />
          <Text style={s.small}>{t.record.slipTotal}</Text>
          <TextInput style={s.input} value={draft.total} onChangeText={(total) => setDraft({ ...draft, total })} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={C.faint} />
          {draft.lines.map((line, index) => (
            <View key={`${index}-${line.text}`} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingTop: 12, marginTop: 12 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={[s.small, line.confidence < 0.6 ? { color: C.warn } : null]}>{t.record.slipConfidence(Math.round(line.confidence * 100))}</Text>
                {line.notes.length ? <Pill>{t.record.slipCheck}</Pill> : null}
              </View>
              <Muted>{line.text}</Muted>
              <Text style={s.small}>{t.record.slipItem}</Text>
              <TextInput style={s.input} value={line.item} onChangeText={(item) => updateLine(index, { item })} placeholder={t.record.slipItem} placeholderTextColor={C.faint} />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={s.small}>{t.record.slipQty}</Text>
                  <TextInput style={s.input} value={line.qty} onChangeText={(qty) => updateLine(index, { qty })} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={C.faint} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.small}>{t.record.slipUnit}</Text>
                  <TextInput style={s.input} value={line.unit} onChangeText={(unit) => updateLine(index, { unit })} placeholder="kg" placeholderTextColor={C.faint} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.small}>{t.record.slipPrice}</Text>
                  <TextInput style={s.input} value={line.amount} onChangeText={(amount) => updateLine(index, { amount })} keyboardType="decimal-pad" placeholder="₹" placeholderTextColor={C.faint} />
                </View>
              </View>
              {line.notes.map((note) => <Muted key={note}>{note}</Muted>)}
            </View>
          ))}
          <Button kind="plain" label={t.record.slipAddLine} onPress={addSlipLine} />
          <Button label={t.record.slipConfirm} onPress={saveSlip} disabled={busy || draft.lines.some((line) => !line.item.trim() || line.item === '?')} />
          <Button label={t.record.slipDiscard} kind="plain" onPress={() => setDraft(null)} disabled={busy} />
        </Card>
      ) : null}
    </>
  );
}

function VoiceIt() {
  const nav = useNav();
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [micBlocked, setMicBlocked] = useState(false);
  const recordingRef = useRef(false);
  const chunks = useRef<string[]>([]);
  const startedAt = useRef(0);
  const SAMPLE_RATE = 16000;
  const MAX_RECORDING_SECONDS = 60;

  async function stopAndRead() {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    setBusy(true);
    setError(null);
    let wavPath: string | null = null;
    try {
      await LiveAudioStream.stop();
      const audioChunks = chunks.current.splice(0);
      if (!audioChunks.length) throw new Error('microphone ne audio nahi bheja; permission aur mic jaanch kar phir koshish karein');
      wavPath = await files.writeWav(`${files.cacheDir}/cascade-voice-${Date.now()}.wav`, audioChunks, SAMPLE_RATE);
      const text = await transcribeVoice(wavPath, ledger().lexicon.hotwords());
      setTranscript(text);
      setResult(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (wavPath) {
        const deleted = await files.deleteFile(wavPath);
        if (!deleted) console.warn(`could not delete temporary voice recording: ${wavPath}`);
      }
      setBusy(false);
    }
  }

  useEffect(() => {
    LiveAudioStream.on('data', (data) => {
      if (recordingRef.current) chunks.current.push(data);
    });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && recordingRef.current) void stopAndRead();
    });
    return () => {
      subscription.remove();
      if (recordingRef.current) {
        recordingRef.current = false;
        void LiveAudioStream.stop();
      }
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt.current) / 1000);
      setSeconds(elapsed);
      if (elapsed >= MAX_RECORDING_SECONDS) void stopAndRead();
    }, 250);
    return () => clearInterval(timer);
  }, [recording]);

  async function startRecording() {
    setError(null);
    setResult(null);
    setTranscript('');
    try {
      const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (permission === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        // Android no longer shows the prompt after "don't ask again": only the app's settings page can allow it
        setMicBlocked(true);
        throw new Error('mic band hai (pehle "Allow nahi" chuna gaya tha). Neeche button se Settings kholein: Permissions > Microphone > Allow');
      }
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('mic ki permission nahi mili; phir se "Bolna shuru karein" dabakar Allow chunein');
      setMicBlocked(false);
      chunks.current = [];
      await LiveAudioStream.init({
        sampleRate: SAMPLE_RATE,
        channels: 1,
        bitsPerSample: 16,
        audioSource: 6,
        wavFile: '',
        bufferSize: 4096,
      });
      recordingRef.current = true;
      startedAt.current = Date.now();
      setSeconds(0);
      await LiveAudioStream.start();
      setRecording(true);
    } catch (e) {
      recordingRef.current = false;
      setError((e as Error).message);
    }
  }

  async function bookTranscript() {
    if (!transcript.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = await ledger().handleText(transcript.trim(), 'voice');
      setResult({ events: parsed.events, unparsed: parsed.unparsed, engine: parsed.engine, fallback: parsed.fallback_reason, normalized: parsed.normalized_text });
      setTranscript('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card title={t.record.voiceTitle}>
        <Muted>{t.record.voiceNote}</Muted>
        <Button label={recording ? t.record.voiceStop(seconds) : busy ? t.record.voiceReading : t.record.voiceStart} onPress={recording ? stopAndRead : startRecording} disabled={busy} />
        <ErrorLine error={error} />
        {micBlocked ? <Button kind="warn" label="Settings kholo (mic allow karo)" onPress={() => void Linking.openSettings()} /> : null}
        {busy ? <Muted>{t.record.voiceProgress}</Muted> : null}
        {transcript ? (
          <>
            <Text style={s.small}>{t.record.voiceHeard}</Text>
            <TextInput
              style={[s.input, { minHeight: 100, textAlignVertical: 'top', paddingTop: 12 }]}
              multiline
              value={transcript}
              onChangeText={setTranscript}
              placeholderTextColor={C.faint}
              accessibilityLabel={t.record.voiceHeard}
            />
            <Button label={t.record.voiceBook} onPress={bookTranscript} disabled={busy || !transcript.trim()} />
            <Button kind="plain" label={t.record.voiceDiscard} onPress={() => setTranscript('')} disabled={busy} />
          </>
        ) : null}
      </Card>

      {result ? (
        <Card title={result.events.length ? t.record.booked(result.events.length, result.engine) : t.record.nothing(result.engine)} tone={result.events.length ? 'good' : undefined}>
          {result.normalized ? <Muted>{t.record.normalized(result.normalized)}</Muted> : null}
          {result.events.map((event) => (
            <EntryRow key={event.id} e={event} onPress={() => nav.push({ name: 'entry', id: event.id })} />
          ))}
          {result.unparsed.length ? <Text style={[s.body, { color: C.warn }]}>{t.record.unparsed}: “{result.unparsed.join('” · “')}”</Text> : null}
          {result.fallback ? <Muted>{t.record.fallback(result.fallback)}</Muted> : null}
        </Card>
      ) : null}
    </>
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
