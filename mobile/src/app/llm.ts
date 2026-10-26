// The language model on the phone: the same Qwen3-VL-4B-Instruct weights as the laptop's Ollama
// (copied over USB, checksums verified), run by llama.cpp through llama.rn. Same prompt, same JSON schema,
// same settings (core/prompts.generated.ts). Loading is slow (seconds) and reported, never hidden.
import { initLlama, type LlamaContext, type NativeCompletionTokenProb } from 'llama.rn';
import type { LastExit } from './device';
import { files } from './files';
import type { Source } from '../core/events';
import { parseExtraction, stripAssistantMarkers } from '../core/extract';
import { ModelUnavailable, type Extractor } from '../core/ledger';
import type { Lexicon } from '../core/lexicon';
import { EXTRACT_OPTIONS, EXTRACT_SCHEMA, extractSystem } from '../core/prompts.generated';

export const MODEL_DIR = `${files.externalFilesDir}/models`;
export const QWEN = 'qwen3-vl-4b-instruct.gguf'; // Q4_K_M (= the laptop's Ollama blob): CPU only on Android
// The same model in Q4_0, the only 4-bit format llama.cpp's Adreno (OpenCL) backend accelerates. If it is on
// the phone it is used with every layer on the GPU; CPU measured 25 s to load and >6 min per sentence.
export const QWEN_GPU = 'Qwen3-VL-4B-Instruct-Q4_0.gguf';
export const QWEN_MMPROJ = 'qwen3-vl-4b-instruct-mmproj.gguf';
export const SLIP_TRANSCRIBE = 'Read the handwritten purchase slip. Return only one short line per item, in this exact format: item | quantity and unit | price. Copy every item, quantity, unit, and price exactly; include prices written at the far right. If a total is written, add one final line: TOTAL | amount. Do not describe the photo, explain, translate, guess missing values, or add any other text.';
const N_CTX = 4096; // the prompt (rules + examples + lexicon) is ~2.5k tokens; answers are capped at 1024

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export type ImageAnswer = { content: string; probabilities: NativeCompletionTokenProb[]; truncated: boolean };

export type LlmState = {
  state: 'off' | 'loading' | 'ready' | 'error';
  error: string | null;
  file: string;
  loadSeconds: number | null;
  gpu: boolean | null; // what llama.cpp reports after loading, not what we asked for
  device: string | null;
  last: { promptTokens: number; promptSeconds: number; outTokens: number; outSeconds: number; cachedTokens?: number; wallSeconds?: number } | null;
  notice: string | null; // something the vendor should know (the app closed during a model call last time)
};

/** What one model call cost, from llama.cpp's own timings plus the wall clock around the call. */
function measured(r: any, t0: number): NonNullable<LlmState['last']> {
  const tm = r?.timings ?? {};
  return {
    promptTokens: tm.prompt_n ?? 0,
    promptSeconds: (tm.prompt_ms ?? 0) / 1000,
    outTokens: tm.predicted_n ?? 0,
    outSeconds: (tm.predicted_ms ?? 0) / 1000,
    cachedTokens: tm.cache_n ?? 0,
    wallSeconds: (Date.now() - t0) / 1000,
  };
}

export type ModelSetup = { file: string; gpu: boolean; mmap: boolean; threads: number };
export const DEFAULT_SETUP: ModelSetup = { file: QWEN_GPU, gpu: false, mmap: false, threads: 4 };

/** Saved settings that survive the app being killed (the app's meta table). */
export type CrashGuard = { get(key: string): string | null; set(key: string, value: string | null): void };

class Llm {
  private ctx: LlamaContext | null = null;
  private loading: Promise<LlamaContext> | null = null;
  private multimodalLoading: Promise<void> | null = null;
  status: LlmState = { state: 'off', error: null, file: `${MODEL_DIR}/${QWEN}`, loadSeconds: null, last: null, gpu: null, device: null, notice: null };
  private listeners = new Set<() => void>();
  private guard: CrashGuard | null = null;

  /**
   * A crash inside llama.cpp kills the whole app; JavaScript never sees it. So every native model call is
   * written down before it starts and crossed out after. If the app starts and finds one still written, that
   * call took the app down: the GPU is no longer used for the model (the CPU path is slower but has never
   * crashed here), and the vendor is told why.
   */
  useGuard(guard: CrashGuard, lastExit: () => Promise<LastExit>) {
    this.guard = guard;
    const died = guard.get('llm_busy');
    if (!died) return;
    guard.set('llm_busy', null);
    // Android says how the last run ended: only a crash counts (not the vendor swiping the app away)
    this.guardChecked = lastExit().then((exit) => {
      const how = exit?.reason ?? 'unknown';
      console.error('[llm] previous run ended inside a model call:', died, how, exit?.description);
      if (how === 'crash_native' || how === 'crash' || how === 'unknown') {
        if (died.includes('gpu')) guard.set('llm_cpu_only', `the app crashed while the model was ${died}`);
        this.set({ notice: `Pichhli baar model chalate waqt app band ho gaya tha (${died}). Ab model sirf CPU par chalega.` });
      } else if (how === 'low_memory') {
        this.set({ notice: `Pichhli baar phone ki memory kam padne se Android ne app band kiya (${died}). Doosre apps band karke phir koshish karein.` });
      }
    }, (e) => console.error('[llm] could not read the last exit reason', e));
  }
  private guardChecked: Promise<void> = Promise.resolve();

  /** How the model runs. Measured on the 12R (Jaanch): see DEFAULT_SETUP. Jaanch can switch it to compare. */
  setup: ModelSetup = DEFAULT_SETUP;
  async configure(setup: ModelSetup) {
    await this.release();
    this.setup = setup;
  }
  async release() {
    const ctx = this.ctx;
    this.ctx = null;
    this.loading = null;
    this.multimodalLoading = null;
    if (ctx) await ctx.release();
    this.set({ state: 'off', loadSeconds: null, gpu: null, device: null, last: null });
  }
  private async guarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
    this.guard?.set('llm_busy', `${what} on ${this.status.gpu ? 'gpu' : 'cpu'}`);
    try {
      return await fn();
    } finally {
      this.guard?.set('llm_busy', null);
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private set(patch: Partial<LlmState>) {
    this.status = { ...this.status, ...patch };
    for (const fn of [...this.listeners]) fn();
  }

  /** Load the model once (a few seconds); every later call reuses it. Errors say exactly what's missing. */
  load(): Promise<LlamaContext> {
    if (this.ctx) return Promise.resolve(this.ctx);
    if (this.loading) return this.loading;
    const t0 = Date.now();
    this.set({ state: 'loading', error: null });
    this.loading = (async () => {
      await this.guardChecked;
      if (!files.externalFilesDir) throw new ModelUnavailable('Android gave this app no external files folder (storage unavailable)');
      const cpuOnly = this.guard?.get('llm_cpu_only') || null;
      const s = this.setup;
      const useGpu = s.gpu && !cpuOnly;
      const file = `${MODEL_DIR}/${s.file}`;
      if ((await files.fileSize(file)) <= 0) throw new ModelUnavailable(`the model file is missing or inaccessible: ${file} (copy it over USB and make the models folder readable by the app)`);
      this.set({ file, gpu: useGpu });
      const ctx = await this.guarded('loading the model', () => initLlama({
        model: file,
        n_ctx: N_CTX,
        n_parallel: 1,
        ctx_shift: false,
        use_mlock: false,
        // the files sit on /sdcard (FUSE): mapping them makes every weight read go through FUSE; reading
        // them into RAM once avoids that (2.4 GB of the 12R's 15.5 GB)
        use_mmap: s.mmap,
        n_threads: s.threads,
        n_gpu_layers: useGpu ? 99 : 0,
        // on Android llama.rn picks backends from this list (n_gpu_layers is iOS-only): without it the OpenCL
        // device stays attached even for a "CPU" setup
        devices: useGpu ? undefined : ['CPU'],
      }));
      this.ctx = ctx;
      const c = ctx as any;
      const used = Array.isArray(c.devices) ? c.devices.join('+') : '?';
      const device = `${used}${useGpu ? '' : `, ${s.threads} threads`}${cpuOnly ? ` (GPU off: ${cpuOnly})` : ''}, ${s.file}, ${s.mmap ? 'mmap' : 'in RAM'}`;
      console.log('[llm] loaded', device, c.reasonNoGPU ?? '');
      this.set({ state: 'ready', loadSeconds: Math.round((Date.now() - t0) / 100) / 10, gpu: !!c.gpu, device });
      return ctx;
    })().catch((e) => {
      this.loading = null;
      const msg = e instanceof ModelUnavailable ? e.message : `the model could not be loaded: ${errorMessage(e)}`;
      this.set({ state: 'error', error: msg });
      throw e instanceof ModelUnavailable ? e : new ModelUnavailable(msg);
    });
    return this.loading;
  }

  private async loadMultimodal(): Promise<void> {
    const ctx = await this.load();
    if (await ctx.isMultimodalEnabled()) return;
    if (this.multimodalLoading) return this.multimodalLoading;
    this.multimodalLoading = (async () => {
      const file = `${MODEL_DIR}/${QWEN_MMPROJ}`;
      if ((await files.fileSize(file)) <= 0) {
        throw new ModelUnavailable(`the vision projector is missing or inaccessible: ${file} (copy it over USB and make the models folder readable by the app)`);
      }
      // The vision encoder runs on the CPU. On the 12R's Adreno (OpenCL) llama.cpp could not allocate the
      // image encoder's graph and dereferenced null in lm_ggml_gallocr_alloc_graph (clip_image_batch_encode):
      // a SIGSEGV that closed the app a few seconds into every slip. Measured: tombstones 2026-10-26 08:00.
      const enabled = await this.guarded('starting vision', () => ctx.initMultimodal({ path: file, use_gpu: false, image_max_tokens: 512 }));
      if (!enabled) throw new ModelUnavailable(`the vision projector could not be initialized: ${file}`);
    })().catch((e) => {
      this.multimodalLoading = null;
      const msg = e instanceof ModelUnavailable ? e.message : `vision could not be initialized: ${errorMessage(e)}`;
      this.set({ error: msg });
      throw e instanceof ModelUnavailable ? e : new ModelUnavailable(msg);
    });
    return this.multimodalLoading;
  }

  /** Read one bounded photo with Qwen-VL. `n_probs` supplies token evidence for per-line confidence. */
  async image(path: string, nPredict: number, nProbs: number): Promise<ImageAnswer> {
    const ctx = await this.load();
    await this.loadMultimodal();
    const t0 = Date.now();
    let r;
    try {
      r = await this.guarded('reading a photo', () => ctx.completion({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: SLIP_TRANSCRIBE },
            { type: 'image_url', image_url: { url: path.startsWith('file://') ? path : `file://${path}` } },
          ],
        }],
        temperature: 0,
        n_predict: nPredict,
        n_probs: nProbs,
        enable_thinking: false,
      }));
    } catch (error) {
      console.error('Qwen multimodal image inference failed', error);
      throw new ModelUnavailable(`Qwen could not read this photo: ${errorMessage(error)}`);
    }
    this.set({ last: measured(r, t0) });
    console.log('[llm] image', JSON.stringify(this.status.last));
    return {
      content: stripAssistantMarkers(r.content || r.text),
      probabilities: r.completion_probabilities ?? [],
      truncated: !!r.stopped_limit || r.truncated,
    };
  }

  /** Stop the answer being written now (the vendor gave up waiting); the call then returns what it had. */
  async stop(): Promise<void> {
    if (this.ctx) await this.ctx.stopCompletion();
  }

  /** One structured answer: system + user message, JSON schema enforced, temperature 0. */
  async json(system: string, user: string, schema: string, nPredict: number) {
    const ctx = await this.load();
    const t0 = Date.now();
    const r = await this.guarded('reading text', () => ctx.completion({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { schema: JSON.parse(schema) } },
      temperature: 0,
      n_predict: nPredict,
      enable_thinking: false, // an instruct model; extractor.py sends think=False too
    }));
    this.set({ last: measured(r, t0) });
    console.log('[llm] json', JSON.stringify(this.status.last));
    if (r.stopped_limit || r.truncated) throw new ModelUnavailable(`the model's answer was cut off after ${nPredict} tokens`);
    return r.content || r.text;
  }
}

export const llm = new Llm();

/** extractor.py's Extractor, on the phone. */
export function phoneExtractor(lexicon: Lexicon): Extractor {
  return {
    name: 'qwen3-vl-4b-instruct (phone)',
    async fromText(text: string, source: Source) {
      // Measured on the 12R: CPU load 25 s, and one sentence took over 6 minutes. A trade must never wait for
      // that, so the model is used only once it is loaded; until then the rule parser books it at once.
      if (llm.status.state !== 'ready') {
        throw new ModelUnavailable(llm.status.state === 'loading' ? 'the model is still loading' : 'the model is not loaded on this phone yet');
      }
      const answer = await llm.json(extractSystem(lexicon.promptBlock()), `text: ${text}`, EXTRACT_SCHEMA, EXTRACT_OPTIONS.n_predict);
      return parseExtraction(answer, text, source);
    },
  };
}
