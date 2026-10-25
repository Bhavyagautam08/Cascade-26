// The language model on the phone: the same Qwen3-VL-4B-Instruct weights as the laptop's Ollama
// (copied over USB, checksums verified), run by llama.cpp through llama.rn. Same prompt, same JSON schema,
// same settings (core/prompts.generated.ts). Loading is slow (seconds) and reported, never hidden.
import { initLlama, type LlamaContext } from 'llama.rn';
import { files } from './files';
import type { Source } from '../core/events';
import { parseExtraction } from '../core/extract';
import { ModelUnavailable, type Extractor } from '../core/ledger';
import type { Lexicon } from '../core/lexicon';
import { EXTRACT_OPTIONS, EXTRACT_SCHEMA, extractSystem } from '../core/prompts.generated';

export const MODEL_DIR = `${files.externalFilesDir}/models`;
export const QWEN = 'qwen3-vl-4b-instruct.gguf';
export const QWEN_MMPROJ = 'qwen3-vl-4b-instruct-mmproj.gguf';
const N_CTX = 4096; // the prompt (rules + examples + lexicon) is ~2.5k tokens; answers are capped at 1024

export type LlmState = {
  state: 'off' | 'loading' | 'ready' | 'error';
  error: string | null;
  file: string;
  loadSeconds: number | null;
  last: { promptTokens: number; promptSeconds: number; outTokens: number; outSeconds: number } | null;
};

class Llm {
  private ctx: LlamaContext | null = null;
  private loading: Promise<LlamaContext> | null = null;
  status: LlmState = { state: 'off', error: null, file: `${MODEL_DIR}/${QWEN}`, loadSeconds: null, last: null };
  private listeners = new Set<() => void>();

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
      const file = `${MODEL_DIR}/${QWEN}`;
      if (!files.externalFilesDir) throw new ModelUnavailable('Android gave this app no external files folder (storage unavailable)');
      if ((await files.fileSize(file)) <= 0) throw new ModelUnavailable(`the model file is not on this phone: ${file} (copy it over USB, see docs)`);
      const ctx = await initLlama({ model: file, n_ctx: N_CTX, use_mlock: false });
      this.ctx = ctx;
      this.set({ state: 'ready', loadSeconds: Math.round((Date.now() - t0) / 100) / 10 });
      return ctx;
    })().catch((e) => {
      this.loading = null;
      const msg = e instanceof ModelUnavailable ? e.message : `the model could not be loaded: ${(e as Error)?.message ?? e}`;
      this.set({ state: 'error', error: msg });
      throw e instanceof ModelUnavailable ? e : new ModelUnavailable(msg);
    });
    return this.loading;
  }

  /** One structured answer: system + user message, JSON schema enforced, temperature 0. */
  async json(system: string, user: string, schema: string, nPredict: number) {
    const ctx = await this.load();
    const r = await ctx.completion({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      json_schema: schema,
      temperature: 0,
      n_predict: nPredict,
      enable_thinking: false, // an instruct model; extractor.py sends think=False too
    });
    const tm = (r as any).timings ?? {};
    this.set({ last: { promptTokens: tm.prompt_n ?? 0, promptSeconds: (tm.prompt_ms ?? 0) / 1000, outTokens: tm.predicted_n ?? 0, outSeconds: (tm.predicted_ms ?? 0) / 1000 } });
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
      const answer = await llm.json(extractSystem(lexicon.promptBlock()), `text: ${text}`, EXTRACT_SCHEMA, EXTRACT_OPTIONS.n_predict);
      return parseExtraction(answer, text, source);
    },
  };
}
