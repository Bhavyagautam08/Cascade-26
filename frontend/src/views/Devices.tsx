import { useEffect, useState } from "react";
import { api } from "../api";
import type { Data } from "../App";
import { Icon } from "../icons";
import { ErrorLine, Panel, useAction, ViewHead } from "../ui";

// Hosts that count as "on this phone or the family network" (offline checklist item 10).
function isLocal(host: string) {
  const h = host.replace(/^\[|\]$/g, "");
  return (
    h === "localhost" || h === "::1" || h.endsWith(".local") ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)
  );
}

/** Every request this page has made (scripts, styles, fonts, API calls), as the browser saw them. */
function useRemoteRequests() {
  const [seen, setSeen] = useState({ total: 0, remote: [] as string[] });
  useEffect(() => {
    const hosts = new Set<string>();
    let total = 0;
    const take = (entries: PerformanceEntryList) => {
      for (const e of entries) {
        total++;
        try {
          const u = new URL(e.name);
          if (/^https?:$/.test(u.protocol) && !isLocal(u.hostname)) hosts.add(u.host);
        } catch {
          /* data: and blob: URLs are local */
        }
      }
      setSeen({ total, remote: [...hosts] });
    };
    take(performance.getEntriesByType("resource"));
    const obs = new PerformanceObserver((l) => take(l.getEntries()));
    obs.observe({ type: "resource" });
    return () => obs.disconnect();
  }, []);
  return seen;
}

type Check = { label: string; ok: boolean; value: string; note: string };

export default function Devices(d: Data) {
  const { health, summary } = d;
  const [result, setResult] = useState<Record<string, { added?: number; error?: string }> | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const { busy, error, run } = useAction();
  const net = useRemoteRequests();
  const peers = health?.peers ?? [];
  const frontier = Object.entries(summary?.frontier ?? {}).sort();
  const demo = health?.model_mode === "demo";

  async function sync() {
    const r = await run(() => api.syncNow());
    if (r) {
      setResult(r);
      setLastSync(new Date());
      d.refresh();
    }
  }

  const checks: Check[] = [
    {
      label: "This phone's ledger",
      ok: !d.offline && !!health,
      value: !d.offline && health ? `${health.device_id}, ${health.events} entries` : "not answering",
      note: "Runs on this laptop",
    },
    {
      label: "Reading trades",
      ok: demo || !!health?.llm_ready,
      value: demo ? "practice stand-in" : health?.llm_ready ? health.llm_model : health?.ollama_models ? `${health.llm_model} not downloaded` : "language model off",
      note: health?.llm_ready || demo ? "Local language model" : "Word rules take over, nothing is lost",
    },
    {
      label: "Reading slips",
      ok: demo || !!health?.llm_ready,
      value: demo ? "sample slip" : health?.llm_ready ? health.llm_model : "unavailable",
      note: health?.llm_ready || demo ? "Same model, loaded once" : "Type the slip's lines in instead",
    },
    {
      label: "Listening",
      ok: true,
      value: demo ? "practice stand-in" : health?.whisper_model ?? "—",
      note: "Configured speech model. A smaller one takes over without a graphics card.",
    },
    {
      label: "Mic",
      ok: !!health?.mic_listening,
      value: health?.mic_listening ? "listening" : "off",
      note: health?.mic_listening ? "Audio is thrown away once read" : "Only the main phone needs it on",
    },
    {
      label: "Phone clock",
      ok: !health || health.hostile_clock === "off",
      value: health ? (health.hostile_clock === "off" ? "normal" : `broken on purpose (${health.hostile_clock})`) : "—",
      note: "Ignored for ordering either way",
    },
    {
      label: "Internet use",
      ok: net.remote.length === 0,
      value: net.remote.length ? `${net.remote.length} outside ${net.remote.length === 1 ? "site" : "sites"}` : "none",
      note: net.remote.length ? net.remote.join(", ") : `${net.total} requests checked, all on this phone or the family network`,
    },
  ];

  return (
    <>
      <ViewHead
        title="Family devices"
        line={peers.length ? `${health?.device_id} shares its books with ${peers.length} other ${peers.length === 1 ? "phone" : "phones"} whenever they meet. No server, no internet.` : "No other phones set up yet."}
        actions={
          <button className="btn primary" disabled={busy || peers.length === 0} onClick={sync}>
            <Icon.sync /> {busy ? "Swapping entries…" : "Sync now"}
          </button>
        }
      />
      <div className="grid">
        <Panel
          title="Other phones"
          className="span-7"
          note="Each phone sends only what the other is missing. Any order, any number of times: the same books on every phone."
          aside={lastSync && <span className="muted">Last sync {lastSync.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>}
        >
          {peers.length === 0 ? (
            <p className="hint">Add the other phones' addresses as <code>PEERS=http://&lt;ip&gt;:8000,…</code> in <code>backend\.env</code>.</p>
          ) : (
            <ul className="rows">
              {peers.map((p) => {
                const r = result?.[p];
                return (
                  <li key={p} className="kv">
                    <code>{p}</code>
                    <span>
                      {!r ? <span className="muted">not synced yet</span> : r.error ? <span className="warn">couldn't reach it, try again when it's nearby</span> : <span>{r.added ? `${r.added} new ${r.added === 1 ? "entry" : "entries"}` : "already up to date"}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <ErrorLine error={error} />
          <h3 className="sub-head">What this phone has seen</h3>
          <div className="chips">
            {frontier.length === 0 && <span className="muted">Empty book</span>}
            {frontier.map(([dev, n]) => (
              <span key={dev} className={`chip ${dev === health?.device_id ? "self" : ""}`}>
                <code>{dev}</code> <span className="num">{n} {n === 1 ? "entry" : "entries"}</span>
              </span>
            ))}
          </div>
        </Panel>
        <Panel title="Works without internet" className="span-5" note="Every part has a fallback that stays on this phone.">
          <ul className="rows checks">
            {checks.map((c) => (
              <li key={c.label}>
                <span className={`dot ${c.ok ? "good" : "warn"}`} aria-hidden="true" />
                <span className="row-main">
                  <span><span className="muted">{c.label}:</span> <b>{c.value}</b></span>
                  <small>{c.note}</small>
                </span>
              </li>
            ))}
          </ul>
          {health?.ollama_models && health.ollama_models.length > 0 && (
            <>
              <h3 className="sub-head">Models on this laptop</h3>
              <div className="chips">
                {health.ollama_models.map((m) => <span key={m} className={`chip ${m === health.llm_model ? "self" : ""}`}><code>{m}</code></span>)}
              </div>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
