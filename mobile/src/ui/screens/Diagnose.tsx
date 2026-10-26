// Jaanch: measure, don't guess. Times every stage of the model paths on this phone and shows the numbers
// (also logged as "[diag]" so they can be read over USB with `adb logcat -s ReactNativeJS`).
import { getBackendDevicesInfo } from 'llama.rn';
import React, { useState } from 'react';
import { Text } from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { files } from '../../app/files';
import { llm } from '../../app/llm';
import { phoneExtractor, QWEN, QWEN_GPU, type ModelSetup } from '../../app/llm';
import { readSlipPhoto } from '../../app/slipReader';
import { ledger, useNav } from '../common';
import { Button, Card, ErrorLine, Muted, Screen, s } from '../kit';

const SENTENCE = '3 kilo tamatar liya 180 mein or sharma ji ka 60 udhar';

export function Diagnose() {
  const nav = useNav();
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const log = (x: string) => {
    console.log(`[diag] ${x}`);
    setLines((l) => [...l, x]);
  };

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    log(`--- ${name}`);
    try {
      await fn();
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      log(`FAILED: ${msg}`);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  const devices = () => run('devices', async () => {
    for (const d of await getBackendDevicesInfo()) log(`${d.backend} ${d.type} ${d.deviceName} mem=${Math.round(d.maxMemorySize / 1e6)}MB`);
  });

  const text = () => run('text (Qwen, same prompt as the laptop)', async () => {
    const t0 = Date.now();
    await llm.load();
    log(`load ${(Date.now() - t0) / 1000}s (state ${llm.status.state}) on ${llm.status.device} from ${llm.status.file.split('/').pop()}`);
    const ex = phoneExtractor(ledger().lexicon);
    for (const pass of ['cold', 'warm']) {
      const t1 = Date.now();
      const out = await ex.fromText(SENTENCE, 'manual');
      const m = llm.status.last!;
      log(`${pass}: total ${(Date.now() - t1) / 1000}s | prompt ${m.promptTokens} tok in ${m.promptSeconds.toFixed(1)}s (cached ${m.cachedTokens}) | answer ${m.outTokens} tok in ${m.outSeconds.toFixed(1)}s`);
      log(`${pass}: ${out.events.map((e) => `${e.kind} ${e.item ?? ''} ${e.qty ?? ''} ₹${e.amount_rupees ?? '?'} ${e.party ?? ''}`).join(' | ')}`);
    }
  });

  // the Parchi screen's own path (readSlipPhoto), timed
  const slip = (uri: string) => async () => {
    const t0 = Date.now();
    const out = await readSlipPhoto(uri, ledger().lexicon.data);
    const m = llm.status.last!;
    log(`on ${llm.status.device}: total ${(Date.now() - t0) / 1000}s | prompt ${m.promptTokens} tok in ${m.promptSeconds.toFixed(1)}s | answer ${m.outTokens} tok in ${m.outSeconds.toFixed(1)}s`);
    for (const l of out.lines) log(`${l.item} | ${l.qty ?? '?'} ${l.unit ?? ''} | ₹${l.amount_rupees ?? '?'} | ${Math.round(l.confidence * 100)}%${l.notes.length ? ` | ${l.notes.join('; ')}` : ''}`);
    log(`total on slip: ₹${out.total_rupees ?? '?'}; lines add to ₹${out.lines.reduce((x, l) => x + (l.amount_rupees ?? 0), 0)}; ${out.warnings.join(' / ')}`);
  };
  const image = () => run('parchi from the gallery', async () => {
    const res = await launchImageLibrary({ mediaType: 'photo', selectionLimit: 1 });
    const uri = res.assets?.[0]?.uri;
    if (!uri) throw new Error('no photo chosen');
    await slip(uri)();
  });
  const sample = () => run('sample parchi (files/diag/slip.jpg)', async () => {
    const path = `${files.externalFilesDir}/diag/slip.jpg`;
    if ((await files.fileSize(path)) <= 0) throw new Error(`no sample photo at ${path} (copy one there over USB)`);
    await slip(`file://${path}`)();
  });

  const use = (label: string, setup: ModelSetup) => () => run(`setup: ${label}`, async () => {
    await llm.configure(setup);
    log(`next load: ${JSON.stringify(setup)}`);
  });

  return (
    <Screen title="Jaanch (diagnostics)" line="Har hisse ka samay is phone par naapta hai." onBack={nav.pop}>
      <Card title="Model setup (to compare)">
        <Muted>{`now: ${JSON.stringify(llm.setup)}`}</Muted>
        <Button small kind="soft" label="CPU, Q4_0, in RAM, 4 threads" onPress={use('cpu-ram-4', { file: QWEN_GPU, gpu: false, mmap: false, threads: 4 })} disabled={busy} />
        <Button small kind="soft" label="CPU, Q4_0, in RAM, 6 threads" onPress={use('cpu-ram-6', { file: QWEN_GPU, gpu: false, mmap: false, threads: 6 })} disabled={busy} />
        <Button small kind="soft" label="CPU, Q4_0, mmap, 4 threads" onPress={use('cpu-mmap-4', { file: QWEN_GPU, gpu: false, mmap: true, threads: 4 })} disabled={busy} />
        <Button small kind="soft" label="CPU, Q4_K_M, in RAM, 4 threads" onPress={use('cpu-qk-ram-4', { file: QWEN, gpu: false, mmap: false, threads: 4 })} disabled={busy} />
        <Button small kind="soft" label="GPU (OpenCL), Q4_0" onPress={use('gpu', { file: QWEN_GPU, gpu: true, mmap: false, threads: 4 })} disabled={busy} />
      </Card>
      <Card>
        <Button label="Devices" onPress={devices} disabled={busy} />
        <Button label="Text test (Qwen)" onPress={text} disabled={busy} />
        <Button label="Parchi test (gallery)" onPress={image} disabled={busy} />
        <Button label="Parchi test (sample file)" onPress={sample} disabled={busy} />
        <ErrorLine error={error} />
      </Card>
      <Card title="Natije">
        {lines.length === 0 ? <Muted>—</Muted> : lines.map((l, i) => <Text key={i} style={s.mono}>{l}</Text>)}
      </Card>
    </Screen>
  );
}
