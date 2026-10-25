import { useState } from "react";
import { api, Health, Summary } from "../api";
import { Card, ErrorLine, useAction } from "../ui";

export default function Sync({ health, summary, onChange }: { health: Health | null; summary: Summary | null; onChange: () => void }) {
  const [result, setResult] = useState<Record<string, { added?: number; error?: string }> | null>(null);
  const { busy, error, run } = useAction();
  const peers = health?.peers ?? [];
  const frontier = Object.entries(summary?.frontier ?? {}).sort();

  async function sync() {
    const r = await run(() => api.syncNow());
    if (r) {
      setResult(r);
      onChange();
    }
  }

  return (
    <Card
      title="Family sync"
      hint="CRDT event set · vector clocks · no server"
      right={
        <button className="btn primary sm" disabled={busy || peers.length === 0} onClick={sync}>
          {busy ? "Syncing…" : "Sync now"}
        </button>
      }
    >
      <div className="stack">
        <div className="small">
          <span className="muted">This device</span> <b>{health?.device_id ?? "…"}</b>
          {health && health.hostile_clock !== "off" && (
            <span className="chip bad" style={{ marginLeft: 8 }}>hostile clock: {health.hostile_clock}</span>
          )}
        </div>
        <div>
          <div className="small muted" style={{ marginBottom: 4 }}>Seen so far (vector clock)</div>
          <div className="row">
            {frontier.length === 0 && <span className="empty">empty log</span>}
            {frontier.map(([d, s]) => (
              <span key={d} className={`chip plain ${d === health?.device_id ? "info" : ""}`}>
                <code>{d}</code> · {s}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="small muted" style={{ marginBottom: 4 }}>Peers</div>
          {peers.length === 0 ? (
            <div className="empty">No peers. Set PEERS=http://&lt;ip&gt;:8000,… in backend\.env</div>
          ) : (
            peers.map((p) => {
              const r = result?.[p];
              return (
                <div key={p} className="row small" style={{ padding: "3px 0" }}>
                  <code>{p}</code>
                  {r?.error && <span className="chip bad">unreachable — retry later</span>}
                  {r && !r.error && <span className="chip good">+{r.added} new</span>}
                </div>
              );
            })
          )}
        </div>
        <ErrorLine error={error} />
        <p className="small muted" style={{ margin: 0 }}>
          Merge is set union, so any order, any number of times gives the same books. Wall clocks are shown but never used to
          order history.
        </p>
      </div>
    </Card>
  );
}
