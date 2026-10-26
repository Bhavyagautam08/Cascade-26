import { initWhisper, initWhisperVad } from 'whisper.rn';
import { files } from './files';
import { byId } from './models';

const WHISPER = byId('whisper').file;
const SILERO = byId('vad').file;
const SPEECH_OPTIONS = {
  threshold: 0.5,
  minSpeechDurationMs: 250,
  minSilenceDurationMs: 100,
  maxSpeechDurationS: 30,
  speechPadMs: 30,
};

function modelFile(name: string): string {
  if (!files.externalFilesDir) throw new Error('Android gave this app no models folder (storage unavailable)');
  return `${files.externalFilesDir}/models/${name}`;
}

async function checkModel(name: string): Promise<string> {
  const path = modelFile(name);
  if ((await files.fileSize(path)) <= 0) {
    throw new Error(`voice model is missing or inaccessible: ${path} (Aur → Models: ek baar download karein)`);
  }
  return path;
}

type Ctx = { whisper: Awaited<ReturnType<typeof initWhisper>>; vad: Awaited<ReturnType<typeof initWhisperVad>> };
let loaded: Promise<Ctx> | null = null;

/** Load Whisper small + Silero once and keep them (reloading 465 MB for every sentence cost seconds each time). */
export function loadVoice(): Promise<Ctx> {
  if (!loaded) {
    loaded = (async () => {
      const whisperPath = await checkModel(WHISPER);
      const sileroPath = await checkModel(SILERO);
      const whisper = await initWhisper({ filePath: `file://${whisperPath}`, useGpu: false });
      const vad = await initWhisperVad({ filePath: `file://${sileroPath}`, useGpu: false, nThreads: 2 });
      return { whisper, vad };
    })().catch((e) => {
      loaded = null; // let the next attempt retry, and show this error
      throw e;
    });
  }
  return loaded;
}

/** The recording held no speech (Silero found none, or Whisper read no words): nothing to book, not a fault. */
export class NoSpeech extends Error {}

/** Transcribe one recorded WAV: Silero rejects silence, Whisper reads the speech. Models stay loaded. */
export async function transcribeVoice(wavPath: string, prompt: string): Promise<string> {
  const { whisper, vad } = await loadVoice();
  {
    const audioUri = `file://${wavPath}`;
    const speech = await vad.detectSpeech(audioUri, SPEECH_OPTIONS);
    if (!speech.length) throw new NoSpeech('koi awaaz nahi suni; paas se bolkar phir koshish karein');
    const { promise } = whisper.transcribe(audioUri, {
      language: 'en',
      prompt: prompt || undefined,
      maxThreads: 4,
    });
    const result = await promise;
    if (result.isAborted) throw new Error('voice reading was stopped before it finished');
    const text = result.result.trim();
    if (!text || /^\[[^\]]*\]$|^\([^)]*\)$/.test(text)) throw new NoSpeech('awaaz suni, par shabd samajh nahi aaye; dheere aur saaf bolkar koshish karein'); // "[BLANK_AUDIO]", "(music)"
    return text;
  }
}
