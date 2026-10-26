// The model files the app needs, where they come from, and how to check them. Downloaded once (Wi-Fi), then
// the app is offline. Sizes and SHA-256 are Hugging Face's own LFS records, checked against the files tested
// on the 12R (2026-10-26). Typing, udhaar, stock and sync work without any of them.
import { device, onDownload, type DownloadEvent } from './device';
import { files } from './files';

export type ModelFile = { id: string; file: string; url: string; size: number; sha256: string; for: string };

export const MODELS: ModelFile[] = [
  {
    id: 'qwen',
    file: 'Qwen3-VL-4B-Instruct-Q4_0.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3-VL-4B-Instruct-GGUF/resolve/main/Qwen3-VL-4B-Instruct-Q4_0.gguf',
    size: 2375774496,
    sha256: '09965766e92778b591ab9da5209463b843d000449b38d909055b399d8dbd3d76',
    for: 'Parchi padhna, model se hisaab samajhna',
  },
  {
    id: 'vision',
    file: 'Qwen3-VL-4B-Instruct-mmproj-BF16.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3-VL-4B-Instruct-GGUF/resolve/main/mmproj-BF16.gguf',
    size: 839326368,
    sha256: '364ef9a7502b7e9a834b9c013b953670f6ba2550b4a26fc043c317fa484eb53e',
    for: 'Parchi ki photo dekhna',
  },
  {
    id: 'whisper',
    file: 'ggml-small.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    size: 487601967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    for: 'Awaaz se shabd (Bolo, din bhar sunna)',
  },
  {
    id: 'vad',
    file: 'ggml-silero-v5.1.2.bin',
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
    size: 885098,
    sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
    for: 'Awaaz mein bolna pehchaanna',
  },
];

export const modelPath = (m: ModelFile) => `${files.externalFilesDir}/models/${m.file}`;
export const byId = (id: string) => MODELS.find((m) => m.id === id)!;

export type ModelState = { present: boolean; bytes: number; state: 'missing' | 'partial' | 'downloading' | 'verifying' | 'ready' | 'error'; error: string | null };

/** What is on the phone now. A file counts as present when it has the exact size (downloads are hash-checked
 *  before they get their final name; files copied over USB are trusted by size). */
export async function scanModels(): Promise<Record<string, ModelState>> {
  const out: Record<string, ModelState> = {};
  for (const m of MODELS) {
    const size = await files.fileSize(modelPath(m));
    const part = size === m.size ? 0 : await device.partialSize(modelPath(m));
    out[m.id] = size === m.size
      ? { present: true, bytes: m.size, state: 'ready', error: null }
      : { present: false, bytes: part, state: part > 0 ? 'partial' : 'missing', error: null };
  }
  return out;
}

export async function downloadModel(m: ModelFile): Promise<void> {
  await device.download(m.id, m.url, modelPath(m), m.sha256, m.size);
}

export const totalBytes = MODELS.reduce((x, m) => x + m.size, 0);

/** Downloads one file after another; keeps going while the vendor uses other screens. */
class Downloads {
  states: Record<string, ModelState> = {};
  running = false;
  private stop = false;
  private listeners = new Set<() => void>();

  constructor() {
    onDownload((e: DownloadEvent) => {
      const cur = this.states[e.id];
      if (!cur) return;
      this.set(e.id, { bytes: e.bytes, state: e.state === 'done' ? 'ready' : e.state === 'paused' ? 'partial' : e.state === 'error' ? 'error' : e.state, present: e.state === 'done' });
    });
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private set(id: string, patch: Partial<ModelState>) {
    this.states = { ...this.states, [id]: { ...this.states[id], ...patch } };
    for (const l of [...this.listeners]) l();
  }
  async refresh() {
    const found = await scanModels();
    // a running download's live numbers win over the scan
    for (const id of Object.keys(found)) if (this.states[id]?.state === 'downloading' || this.states[id]?.state === 'verifying') found[id] = this.states[id];
    this.states = found;
    for (const l of [...this.listeners]) l();
  }
  allReady() {
    return MODELS.every((m) => this.states[m.id]?.present);
  }
  async downloadAll() {
    if (this.running) return;
    this.running = true;
    this.stop = false;
    for (const l of [...this.listeners]) l();
    try {
      await this.refresh();
      for (const m of MODELS) {
        if (this.stop) break;
        if (this.states[m.id]?.present) continue;
        this.set(m.id, { state: 'downloading', error: null });
        try {
          await device.download(m.id, m.url, modelPath(m), m.sha256, m.size);
          this.set(m.id, { state: 'ready', present: true, bytes: m.size });
        } catch (e) {
          const msg = (e as Error).message;
          this.set(m.id, { state: this.stop ? 'partial' : 'error', error: this.stop ? null : msg });
          if (!this.stop) break; // say what went wrong; the next tap resumes from here
        }
      }
    } finally {
      this.running = false;
      for (const l of [...this.listeners]) l();
    }
  }
  pause() {
    this.stop = true;
    for (const m of MODELS) device.cancelDownload(m.id);
  }
}

export const downloads = new Downloads();
