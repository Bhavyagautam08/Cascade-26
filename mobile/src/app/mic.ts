// The phone's one microphone. Android gives audio to one recorder at a time, so this module owns it and
// shares it: the always-on listener hears the whole day, and "record one trade" (or one stock list) borrows
// the stream for a clip and hands it back. Audio is never stored: a clip or utterance is written to a
// temporary WAV for Whisper and deleted right after; only the words survive.
import LiveAudioStream from '@fugood/react-native-audio-pcm-stream';
import { PermissionsAndroid, Platform } from 'react-native';
import type { Ledger } from '../core/ledger';
import { base64Bytes, rmsPcm16, Segmenter, type Utterance } from '../core/segmenter';
import { device } from './device';
import { files } from './files';
import { loadVoice, NoSpeech, transcribeVoice } from './voice';

export const SAMPLE_RATE = 16000;
const MAX_QUEUE = 8; // utterances waiting for Whisper; more than this and the oldest new ones are dropped
const DEAD_WARN_S = 5;

/** Android won't ask again ("don't allow" was chosen twice): only the app's Settings page can allow the mic. */
export class MicBlocked extends Error {}

export async function micPermission(): Promise<void> {
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  if (r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
    throw new MicBlocked('Mic band hai (pehle "Allow nahi" chuna gaya tha). Settings kholkar Permissions > Microphone > Allow karein.');
  }
  if (r !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Mic ki permission nahi mili. Dobara dabakar "Allow" chunein.');
}

async function toText(chunks: string[], ledger: Ledger, tag: string): Promise<string> {
  const wav = await files.writeWav(`${files.cacheDir}/cascade-${tag}-${Date.now()}.wav`, chunks, SAMPLE_RATE);
  try {
    return await transcribeVoice(wav, ledger.lexicon.hotwords());
  } finally {
    if (!(await files.deleteFile(wav))) console.warn(`could not delete temporary recording ${wav}`);
  }
}

// --- the stream ------------------------------------------------------------------------------------
type Clip = { chunks: string[]; started: number; level: number };
let running = false;
let registered = false;
let clip: Clip | null = null;
let consumer: ((chunk: string) => void) | null = null;
const clipListeners = new Set<() => void>();

function onData(chunk: string) {
  if (clip) {
    clip.chunks.push(chunk);
    clip.level = 0.6 * clip.level + 0.4 * rmsPcm16(base64Bytes(chunk));
    for (const l of [...clipListeners]) l();
    return;
  }
  consumer?.(chunk);
}

async function ensureRunning() {
  await micPermission();
  if (!registered) {
    LiveAudioStream.on('data', onData);
    registered = true;
  }
  if (running) return;
  await LiveAudioStream.init({ sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16, audioSource: 6, wavFile: '', bufferSize: 4096 });
  LiveAudioStream.start();
  running = true;
}

async function stopIfIdle() {
  if (running && !clip && !consumer) {
    running = false;
    await LiveAudioStream.stop();
  }
}

// --- one clip (record a trade / a stock list) -------------------------------------------------------
export const clipRecorder = {
  get active() {
    return clip !== null;
  },
  get seconds() {
    return clip ? (Date.now() - clip.started) / 1000 : 0;
  },
  get level() {
    return clip?.level ?? 0;
  },
  subscribe(fn: () => void) {
    clipListeners.add(fn);
    return () => {
      clipListeners.delete(fn);
    };
  },
  async start() {
    if (clip) throw new Error('ek recording pehle se chal rahi hai');
    await ensureRunning();
    clip = { chunks: [], started: Date.now(), level: 0 };
    for (const l of [...clipListeners]) l();
  },
  /** Stop and read the clip into words (Silero + Whisper). Throws NoSpeech when nothing was said. */
  async stopAndRead(ledger: Ledger): Promise<string> {
    const c = clip;
    clip = null;
    for (const l of [...clipListeners]) l();
    await stopIfIdle();
    if (!c || !c.chunks.length) throw new Error('mic se awaaz nahi aayi; mic jaanch kar phir boliye');
    return toText(c.chunks, ledger, 'clip');
  },
  async cancel() {
    clip = null;
    for (const l of [...clipListeners]) l();
    await stopIfIdle();
  },
};

// --- always-on listening ------------------------------------------------------------------------------
export type HeardLine = { at: number; text: string; booked: string[]; engine: string | null; repeats: number; held: string | null };
export type ListenStatus = {
  on: boolean;
  state: 'off' | 'starting' | 'listening' | 'error';
  level: number;
  threshold: number;
  reading: number; // utterances waiting for or inside Whisper
  utterances: number;
  dropped: number;
  silent: number; // cut as speech by loudness, but Silero / Whisper found no words
  lastError: string | null;
  warning: string | null;
  heard: HeardLine[];
};

class Listener {
  status: ListenStatus = { on: false, state: 'off', level: 0, threshold: 0, reading: 0, utterances: 0, dropped: 0, silent: 0, lastError: null, warning: null, heard: [] };
  private seg: Segmenter | null = null;
  private queue: Utterance[] = [];
  private working = false;
  private ledger: (() => Ledger) | null = null;
  private listeners = new Set<() => void>();
  private lastNotify = 0;

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private set(patch: Partial<ListenStatus>, force = true) {
    this.status = { ...this.status, ...patch };
    const now = Date.now();
    if (!force && now - this.lastNotify < 200) return; // the level meter: 5 updates a second is plenty
    this.lastNotify = now;
    for (const fn of [...this.listeners]) fn();
  }

  /** The vendor booked a heard sentence by hand (said what it was): show it as booked. */
  markBooked(at: number, ids: string[]) {
    this.set({ heard: this.status.heard.map((h) => (h.at === at ? { ...h, booked: [...h.booked, ...ids] } : h)) });
  }

  /** Start hearing the day. Throws (with the reason) if the mic can't be opened. */
  async start(ledger: () => Ledger) {
    if (this.status.on) return;
    this.ledger = ledger;
    this.set({ state: 'starting', lastError: null, warning: null });
    try {
      this.seg = new Segmenter(SAMPLE_RATE);
      consumer = (chunk) => this.onChunk(chunk);
      await ensureRunning();
    } catch (e) {
      consumer = null;
      this.set({ state: 'error', on: false, lastError: (e as Error).message });
      throw e;
    }
    let warning: string | null = null;
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
      const n = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      if (n !== PermissionsAndroid.RESULTS.GRANTED) warning = 'Notification ki permission nahi mili: phone sunta rahega, par upar "sun raha hai" ki suchna nahi dikhegi.';
    }
    try {
      await device.startListening(); // keeps the mic and CPU allowed with the screen off
    } catch (e) {
      warning = `Screen band hone par sunna ruk sakta hai: ${(e as Error).message}`;
    }
    this.set({ on: true, state: 'listening', warning });
    loadVoice().catch((e) => this.set({ lastError: `awaaz padhne ka model nahi chala: ${(e as Error).message}` }));
  }

  async stop() {
    if (!this.status.on && this.status.state !== 'error') return;
    consumer = null;
    const rest = this.seg?.flush();
    if (rest) this.enqueue(rest);
    this.seg = null;
    await stopIfIdle();
    try {
      await device.stopListening();
    } catch (e) {
      this.set({ lastError: `sunne ki service band nahi hui: ${(e as Error).message}` });
    }
    this.set({ on: false, state: 'off', level: 0 });
  }

  private onChunk(chunk: string) {
    const seg = this.seg;
    if (!seg) return;
    let u: Utterance | null;
    try {
      u = seg.push(chunk);
    } catch (e) {
      this.set({ lastError: (e as Error).message });
      return;
    }
    const dead = seg.deadFor() > DEAD_WARN_S;
    const warning = dead ? 'Mic se lagbhag koi awaaz nahi aa rahi: mic dhaka hua ya band to nahi?' : this.status.warning?.startsWith('Mic se') ? null : this.status.warning;
    this.set({ level: seg.level, threshold: seg.threshold(), warning }, false);
    if (u) this.enqueue(u);
  }

  private enqueue(u: Utterance) {
    if (this.queue.length >= MAX_QUEUE) {
      this.set({ dropped: this.status.dropped + 1 });
      return;
    }
    this.queue.push(u);
    this.set({ reading: this.queue.length + (this.working ? 1 : 0) });
    void this.pump();
  }

  private async pump() {
    if (this.working || !this.ledger) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const u = this.queue.shift()!;
        this.set({ reading: this.queue.length + 1 });
        const L = this.ledger();
        try {
          const text = await toText(u.chunks, L, 'listen');
          // whisper.rn gives no per-word probabilities, so how clearly it was heard is not measured here (1)
          const r = await L.heard(text, 1, 'phone mic');
          const line: HeardLine = { at: Date.now(), text, booked: r.events.map((e) => e.id), engine: r.engine, repeats: 'repeats' in r ? (r.repeats ?? []).length : 0, held: 'held' in r ? r.held : null };
          this.set({ utterances: this.status.utterances + 1, heard: [...this.status.heard, line].slice(-30) });
        } catch (e) {
          if (e instanceof NoSpeech) this.set({ silent: this.status.silent + 1 });
          else this.set({ lastError: (e as Error).message });
        }
      }
    } finally {
      this.working = false;
      this.set({ reading: 0 });
    }
  }
}

export const listener = new Listener();
