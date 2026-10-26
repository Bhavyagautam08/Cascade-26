// Always-on listening: cut the microphone's stream into utterances at pauses. Ported from the laptop's
// backend/app/perception/mic.py (same numbers). Audio is never stored: an utterance is handed on to be
// transcribed and then dropped; only the words survive.
//
// A block counts as speech when it is louder than max(MIN_THRESHOLD, NOISE_MULTIPLE x the room's running
// noise floor), the floor being learnt from quiet blocks only. Speech detection proper happens afterwards
// (Silero VAD before Whisper), so a loud bang cut here is still dropped there.

export const SILENCE_TO_CUT = 0.8; // seconds of quiet that end an utterance
export const MAX_UTTERANCE = 20; // seconds
export const MIN_UTTERANCE = 0.3; // shorter bursts (a clap, a bang) are not sent to Whisper
export const NOISE_MULTIPLE = 3;
export const MIN_THRESHOLD = 0.01; // loudness on a 0..1 scale
export const DEAD_LEVEL = 0.0002; // a working mic in a quiet room reads ~0.001; a muted one ~0.00002
export const PRE_ROLL_BLOCKS = 2; // keep the blocks just before speech, so the first syllable isn't cut

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) LOOKUP[B64.charCodeAt(i)] = i;

/** Base64 (as the audio stream sends it) -> bytes. Throws on anything that isn't base64. */
export function base64Bytes(b64: string): Uint8Array {
  const clean = b64.replace(/[\r\n\s]/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length * 3) / 4 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => {
      const ch = clean.charCodeAt(i + k);
      if (clean[i + k] === '=') return 0;
      const x = ch < 128 ? LOOKUP[ch] : -1;
      if (x < 0) throw new Error(`audio chunk is not base64 (character ${i + k})`);
      return x;
    });
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

/** Loudness (root mean square, 0..1) of 16-bit little-endian mono PCM. */
export function rmsPcm16(bytes: Uint8Array): number {
  const n = Math.floor(bytes.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let s = bytes[2 * i] | (bytes[2 * i + 1] << 8);
    if (s >= 0x8000) s -= 0x10000;
    const f = s / 32768;
    sum += f * f;
  }
  return Math.sqrt(sum / n);
}

export type Utterance = { chunks: string[]; seconds: number };

export class Segmenter {
  level = 0; // smoothed loudness, for the meter
  noiseFloor = 0;
  deadSince: number | null = null; // seconds of stream time when the level fell to near-silence
  private buf: string[] = [];
  private bufSeconds = 0;
  private quiet = 0;
  private preRoll: [string, number][] = [];
  private t = 0; // seconds of audio seen

  constructor(private readonly sampleRate: number, private readonly minThreshold = MIN_THRESHOLD) {}

  threshold(): number {
    return Math.max(this.minThreshold, NOISE_MULTIPLE * this.noiseFloor);
  }

  /** Seconds the mic has delivered near-silence for (muted, covered, or the wrong mic). */
  deadFor(): number {
    return this.deadSince === null ? 0 : this.t - this.deadSince;
  }

  /** Feed one base64 chunk of 16-bit mono PCM; returns an utterance when one just ended. */
  push(chunk: string): Utterance | null {
    const bytes = base64Bytes(chunk);
    const seconds = bytes.length / 2 / this.sampleRate;
    const rms = rmsPcm16(bytes);
    this.t += seconds;
    this.level = 0.7 * this.level + 0.3 * rms;
    if (this.level < DEAD_LEVEL) this.deadSince ??= this.t;
    else this.deadSince = null;
    const speaking = rms > this.threshold();
    if (!speaking) this.noiseFloor = this.noiseFloor === 0 ? rms : 0.98 * this.noiseFloor + 0.02 * rms;
    if (speaking && !this.buf.length) {
      for (const [c, s] of this.preRoll) {
        this.buf.push(c);
        this.bufSeconds += s;
      }
    }
    if (speaking || this.buf.length) {
      this.buf.push(chunk);
      this.bufSeconds += seconds;
      this.preRoll = [];
    } else {
      this.preRoll = [...this.preRoll, [chunk, seconds] as [string, number]].slice(-PRE_ROLL_BLOCKS);
    }
    this.quiet = speaking ? 0 : this.quiet + seconds;
    if (this.buf.length && (this.quiet >= SILENCE_TO_CUT || this.bufSeconds >= MAX_UTTERANCE)) {
      const out = { chunks: this.buf, seconds: this.bufSeconds };
      const voiced = this.bufSeconds - this.quiet;
      this.buf = [];
      this.bufSeconds = 0;
      this.quiet = 0;
      return voiced >= MIN_UTTERANCE ? out : null;
    }
    return null;
  }

  /** Whatever is buffered (the mic is being turned off mid-sentence). */
  flush(): Utterance | null {
    const out = this.buf.length && this.bufSeconds - this.quiet >= MIN_UTTERANCE ? { chunks: this.buf, seconds: this.bufSeconds } : null;
    this.buf = [];
    this.bufSeconds = 0;
    this.quiet = 0;
    return out;
  }
}
