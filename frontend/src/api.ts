// Thin client for the local backend (proxied at /api by Vite). Nothing here leaves localhost.
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: init?.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = await res.text();
    try {
      detail = JSON.parse(detail).detail ?? detail;
    } catch {
      /* plain text */
    }
    throw new Error(`${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

export type Posting = { account: string; amount: number };
export type Payload = {
  item?: string | null;
  qty?: number | null;
  unit?: string | null;
  amount_rupees?: number | null;
  party?: string | null;
  voided?: string;
};
export type LedgerEvent = {
  id: string;
  device_id: string;
  seq: number;
  vclock: Record<string, number>;
  kind: string;
  source: string;
  confidence: number;
  payload: Payload;
  raw: string | null;
  postings: Posting[];
  wall_time: number | null;
  supersedes: string[];
};

export type Health = {
  device_id: string;
  model_mode: "demo" | "real";
  llm_model: string;
  whisper_model: string;
  ollama_models: string[] | null;
  llm_ready: boolean;
  mic_listening: boolean;
  hostile_clock: string;
  peers: string[];
  events: number;
};

export type Conflict = {
  ids: string[];
  party: string;
  kind: string;
  claims_paise: [number, number];
  suspense_paise: number;
};

export type Summary = {
  balanced: boolean;
  balances_paise: Record<string, number>;
  profit: {
    p10: number;
    p50: number;
    p90: number;
    components: { revenue: number; cogs: number; expenses: number; expected_bad_debt: number };
    receivables: Record<string, number>;
  };
  duplicates: string[][];
  conflicts: Conflict[];
  frontier: Record<string, number>;
};

export type IngestResult = { engine: string; is_transaction: boolean; events: LedgerEvent[] };
export type Transcript = {
  text: string;
  confidence: number;
  language: string;
  via: string;
  engine: string | null;
  events: number;
  held?: string | null; // too unclear: shown, not booked
  repeats?: number; // trades already booked from an earlier hearing
};
export type MicStatus = {
  listening: boolean;
  state: "off" | "opening" | "listening" | "reconnecting";
  device: string | null;
  wanted: string | null;
  level: number;
  threshold: number;
  noise_floor: number;
  utterances: number;
  dropped: number;
  reopens: number;
  errors: number;
  last_error: string | null;
  warning: string | null;
  seconds_since_heard: number | null;
};
export type MicDevice = { name: string; default: boolean };

export type InvStatus = "opening" | "purchased" | "unclear";
export type InvItem = {
  item: string;
  said: string | null;
  qty: number | null;
  unit: string | null;
  total_cost: number | null;
  unit_cost: number | null;
  status: InvStatus;
  confidence: number;
  flags: string[];
  question: string | null;
};
export type InvDraft = {
  recording_id: string;
  transcript: string;
  heard_confidence: number | null;
  items: InvItem[];
  open_questions: number;
  already_saved: boolean;
  asr: string | null;
  reader: string | null;
};
/** Confirm returns 409 (would overwrite) and 422 (open questions) as data the screen acts on. */
export type InvConfirmResult =
  | { status: 200; data: { duplicate: boolean; events: LedgerEvent[]; replaced?: string[] } }
  | { status: 409; data: { message: string; existing: { id: string; item: string; qty: number; unit: string; kind: string }[] } }
  | { status: 422; data: { message: string; items: InvItem[] } };

async function confirmInventory(body: unknown): Promise<InvConfirmResult> {
  const res = await fetch("/api/inventory/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (res.status === 200) return { status: 200, data: json };
  if (res.status === 409 || res.status === 422) return { status: res.status, data: json.detail } as InvConfirmResult;
  throw new Error(`${res.status}: ${typeof json.detail === "string" ? json.detail : JSON.stringify(json.detail ?? json)}`);
}
export type SlipLine = { item: string; qty: number | null; unit: string | null; amount_rupees: number | null; confidence: number };
export type Slip = { supplier: string | null; lines: SlipLine[]; total_rupees: number | null; reader: string };

export type Recipe = {
  usage_per_plate: number[][];
  baseline_waste_per_day: number[];
  unexplained_per_day: number[][];
  residual_sd: number[];
};
export type LossSplit = {
  split: Record<"spoilage" | "theft" | "personal", { p: number; p10: number; p90: number; kg: number }>;
  reasons: string[];
};
export type Lexicon = Record<string, Record<string, unknown> | string[]>;

export const api = {
  health: () => call<Health>("/health"),
  events: () => call<LedgerEvent[]>("/events"),
  summary: () => call<Summary>("/ledger/summary"),
  ingestText: (text: string, source: string, engine: string) =>
    post<IngestResult>("/ingest/text", { text, source, engine }),
  simulateHeard: (text: string, confidence = 0.9) => post<IngestResult>("/mic/simulate", { text, confidence }),
  recentTranscripts: () => call<Transcript[]>("/mic/recent"),
  micStatus: () => call<MicStatus>("/mic/status"),
  micDevices: () => call<{ devices: MicDevice[]; current: string | null; wanted: string | null; rescanned: boolean }>("/mic/devices"),
  micStart: (device: string | null) => post<MicStatus>("/mic/start", { device }),
  micStop: () => post<MicStatus>("/mic/stop", {}),
  inventoryVoice: (audio: Blob) => {
    const fd = new FormData();
    fd.append("file", audio, "morning.webm");
    return call<InvDraft>("/inventory/voice", { method: "POST", body: fd });
  },
  inventoryText: (text: string) => post<InvDraft>("/inventory/text", { text }),
  inventoryConfirm: (recording_id: string, transcript: string, items: InvItem[], replace: boolean, typed: boolean) =>
    confirmInventory({ recording_id, transcript, items, replace, typed }),
  newDay: () => post<{ archived_events: number; backup_file: string | null; events: number }>("/day/new", { confirm: true }),
  inventoryToday: () => call<{ day: string; events: LedgerEvent[] }>("/inventory/today"),
  ingestAudio: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return call<IngestResult & { transcript: string | null; confidence?: number; asr?: string }>("/ingest/audio", {
      method: "POST",
      body: fd,
    });
  },
  readSlip: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return call<Slip>("/ingest/slip", { method: "POST", body: fd });
  },
  confirmSlip: (supplier: string | null, lines: SlipLine[]) =>
    post<{ events: LedgerEvent[] }>("/ingest/slip/confirm", { supplier, lines }),
  resolve: (ids: string[], amount_rupees: number) => post<{ events: LedgerEvent[] }>("/ledger/resolve", { ids, amount_rupees }),
  void: (id: string) => post<{ events: LedgerEvent[] }>("/ledger/void", { id }),
  lexicon: () => call<Lexicon>("/lexicon"),
  addLexicon: (section: string, key: string, value: unknown) => post<Lexicon>("/lexicon", { section, key, value }),
  recipe: (burn: number[][], plates: number[][]) => post<Recipe>("/inference/recipe", { burn, plates }),
  loss: (unexplained_kg: number, covariates: Record<string, number | boolean>) =>
    post<LossSplit>("/inference/loss", { unexplained_kg, covariates }),
  syncNow: () => post<Record<string, { added?: number; error?: string }>>("/sync/now", {}),
};

const sign = (x: number) => (x < 0 ? "−" : "");
export const rupees = (paise: number) =>
  `${sign(paise)}₹${Math.abs(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
export const inr = (r: number) => `${sign(Math.round(r))}₹${Math.abs(r).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
