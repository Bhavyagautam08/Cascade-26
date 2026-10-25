import { useState } from "react";
import { api, inr, LedgerEvent, Summary } from "../api";
import { Card, Conf, ErrorLine, KindBadge, useAction } from "../ui";

function wallClock(t: number | null) {
  if (t == null) return { text: "—", bad: false };
  const d = new Date(t * 1000);
  const y = d.getFullYear();
  const bad = y < 2000 || y > 2090;
  const text = bad ? d.toISOString().slice(0, 10) : d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  return { text, bad };
}

function amountOf(e: LedgerEvent) {
  const paise = e.postings.reduce((s, p) => s + Math.max(p.amount, 0), 0);
  return paise ? inr(paise / 100) : e.payload.amount_rupees == null && e.kind !== "adjustment" ? "amount ?" : "";
}

export default function EventLog({ events, summary, onChange }: { events: LedgerEvent[]; summary: Summary | null; onChange: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const { error, run } = useAction();
  const superseded = new Map<string, string>();
  events.forEach((e) => e.supersedes.forEach((s) => superseded.set(s, e.kind === "adjustment" ? "voided" : "resolved")));
  const fusedWith = new Map<string, number>();
  summary?.duplicates.forEach((g) => g.forEach((id) => fusedWith.set(id, g.length)));
  const disputed = new Set(summary?.conflicts.flatMap((c) => c.ids) ?? []);

  const rows = [...events].reverse();
  const shown = showAll ? rows : rows.slice(0, 25);

  return (
    <Card
      title="Event log"
      hint="append-only · ordered by vector clock, never by wall time"
      className="span-2"
      right={<span className="small muted">{events.length} events</span>}
    >
      <ErrorLine error={error} />
      {events.length === 0 ? (
        <div className="empty">Nothing recorded yet — say or type a trade above.</div>
      ) : (
        <div className="table-wrap">
          <table className="log">
            <thead>
              <tr>
                <th>Event</th>
                <th>Kind</th>
                <th>What</th>
                <th className="num">Amount</th>
                <th>Source</th>
                <th>Confidence</th>
                <th>Device clock</th>
                <th>Heard as</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => {
                const gone = superseded.get(e.id);
                const clock = wallClock(e.wall_time);
                return (
                  <tr key={e.id} className={gone ? "dim" : ""}>
                    <td><code>{e.id}</code></td>
                    <td><KindBadge kind={e.kind} /></td>
                    <td className="small">
                      {e.payload.voided
                        ? `void ${e.payload.voided}`
                        : [e.payload.qty != null && `${e.payload.qty} ${e.payload.unit ?? ""}`, e.payload.item, e.payload.party]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                      {fusedWith.has(e.id) && <span className="badge" style={{ marginLeft: 6 }}>fused ×{fusedWith.get(e.id)}</span>}
                      {disputed.has(e.id) && <span className="badge credit_given" style={{ marginLeft: 6 }}>disputed</span>}
                      {gone && <span className="badge" style={{ marginLeft: 6 }}>{gone}</span>}
                    </td>
                    <td className="num">{amountOf(e)}</td>
                    <td className="small">{e.source}</td>
                    <td><Conf value={e.confidence} /></td>
                    <td className={`small ${clock.bad ? "clock-bad" : "muted"}`} title={clock.bad ? "untrusted device clock — ignored for ordering" : ""}>
                      {clock.text}
                    </td>
                    <td className="raw small" title={e.raw ?? ""}>{e.raw}</td>
                    <td>
                      {!gone && e.kind !== "adjustment" && (
                        <button className="btn ghost sm" title="withdraw this entry" onClick={() => run(() => api.void(e.id)).then(onChange)}>
                          void
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 25 && (
        <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setShowAll((s) => !s)}>
          {showAll ? "Show recent only" : `Show all ${rows.length}`}
        </button>
      )}
    </Card>
  );
}
