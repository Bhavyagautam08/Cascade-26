// Thin client for the local backend (proxied at /api by Vite).
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export type Posting = { account: string; amount: number };
export type LedgerEvent = {
  id: string;
  device_id: string;
  kind: string;
  source: string;
  confidence: number;
  raw: string | null;
  postings: Posting[];
  wall_time: number | null;
};

export const api = {
  health: () => call<{ device_id: string; ollama_models: string[] | null; events: number }>("/health"),
  events: () => call<LedgerEvent[]>("/events"),
  balances: () => call<{ balances_paise: Record<string, number>; balanced: boolean }>("/ledger/balances"),
  ingestText: (text: string, source = "manual") =>
    call("/ingest/text", { method: "POST", body: JSON.stringify({ text, source }) }),
  syncNow: () => call<Record<string, unknown>>("/sync/now", { method: "POST" }),
};
