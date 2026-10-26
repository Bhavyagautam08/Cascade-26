// Jaanch: measure, don't guess. Times every stage of the model paths on this phone and shows the numbers
// (also logged as "[diag]" so they can be read over USB with `adb logcat -s ReactNativeJS`).
import ImageResizer from '@bam.tech/react-native-image-resizer';
import { getBackendDevicesInfo } from 'llama.rn';
import React, { useState } from 'react';
import { Text } from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { files } from '../../app/files';
import { llm } from '../../app/llm';
import { phoneExtractor } from '../../app/llm';
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

  const image = () => run('image (Qwen vision)', async () => {
    const res = await launchImageLibrary({ mediaType: 'photo', selectionLimit: 1 });
    const uri = res.assets?.[0]?.uri;
    if (!uri) throw new Error('no photo chosen');
    for (const size of [1280, 768]) {
      const img = await ImageResizer.createResizedImage(uri, size, size, 'JPEG', 90, 0, null, false, { onlyScaleDown: true });
      const t1 = Date.now();
      try {
        const a = await llm.image(img.path.replace(/^file:\/\//, ''), 512, 1);
        const m = llm.status.last!;
        log(`${size}px (${img.width}x${img.height}): total ${(Date.now() - t1) / 1000}s | prompt ${m.promptTokens} tok in ${m.promptSeconds.toFixed(1)}s | answer ${m.outTokens} tok in ${m.outSeconds.toFixed(1)}s | truncated ${a.truncated}`);
        log(`${size}px text: ${a.content.slice(0, 300).replace(/\n/g, ' / ')}`);
      } finally {
        await files.deleteFile(img.path.replace(/^file:\/\//, ''));
      }
    }
  });

  return (
    <Screen title="Jaanch (diagnostics)" line="Har hisse ka samay is phone par naapta hai." onBack={nav.pop}>
      <Card>
        <Button label="Devices" onPress={devices} disabled={busy} />
        <Button label="Text test (Qwen)" onPress={text} disabled={busy} />
        <Button label="Image test (gallery)" onPress={image} disabled={busy} />
        <ErrorLine error={error} />
      </Card>
      <Card title="Natije">
        {lines.length === 0 ? <Muted>—</Muted> : lines.map((l, i) => <Text key={i} style={s.mono}>{l}</Text>)}
      </Card>
    </Screen>
  );
}
