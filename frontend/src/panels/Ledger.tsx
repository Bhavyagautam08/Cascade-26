import { useState } from "react";
import { api, inr, rupees, Summary } from "../api";
import { Card, ErrorLine, useAction } from "../ui";

export function ProfitRange({ summary }: { summary: Summary | null }) {
  if (!summary) return <Card title="True accrual profit"><div className="empty">Loading…</div></Card>;
  const { p10, p50, p90, components: c } = summary.profit;
  const lo = Math.min(p10, 0);
  const hi = Math.max(p90, 0);
  const pad = Math.max((hi - lo) * 0.12, 10);
  const x = (v: number) => `${((v - (lo - pad)) / (hi - lo + 2 * pad)) * 100}%`;
  return (
    <Card title="True accrual profit" hint="Monte Carlo · 2000 draws · never a single number">
      <div className="profit-head">
        <span className="profit-big" style={{ color: p50 < 0 ? "var(--bad)" : undefined }}>
          {inr(p10)} <span className="muted" style={{ fontSize: 20, fontWeight: 500 }}>to</span> {inr(p90)}
        </span>
        <span className="muted">80% likely range · most likely {inr(p50)}</span>
      </div>
      <div className="range" aria-hidden>
        <div className="track" />
        <div className="zero" style={{ left: x(0) }} />
        <span className="lbl bottom" style={{ left: x(0) }}>₹0</span>
        <div className="band" style={{ left: x(p10), width: `calc(${x(p90)} - ${x(p10)})` }} />
        {[p10, p50, p90].map((v, i) => (
          <span key={i}>
            <div className="tick" style={{ left: x(v), opacity: i === 1 ? 1 : 0.55 }} />
            <span className="lbl" style={{ left: x(v) }}>{["p10", "p50", "p90"][i]}</span>
          </span>
        ))}
      </div>
      <div className="kv small" style={{ marginTop: 12 }}>
        <span className="k">Revenue (cash + udhaar sales)</span><span className="v">{inr(c.revenue)}</span>
        <span className="k">− Stock actually used (0–30% may still be unsold)</span><span className="v neg">{inr(c.cogs)}</span>
        <span className="k">− Expenses</span><span className="v neg">{inr(c.expenses)}</span>
        <span className="k">− Expected bad debt (collection ~ Beta(8, 2))</span><span className="v neg">{inr(c.expected_bad_debt)}</span>
      </div>
      <p className="small muted" style={{ margin: "10px 0 0" }}>
        Low-confidence entries wobble more in each draw, so shaky evidence widens the range instead of hiding in it.
      </p>
    </Card>
  );
}

export function CreditBook({ summary, onChange }: { summary: Summary | null; onChange: () => void }) {
  const conflicts = summary?.conflicts ?? [];
  // Receivables from the backend are the certain part only; disputed amounts wait in suspense.
  const disputed = new Map<string, { paise: number; kind: string }>();
  conflicts.forEach((c) => disputed.set(c.party, { paise: c.suspense_paise, kind: c.kind }));
  const parties = new Set([...Object.keys(summary?.profit.receivables ?? {}), ...disputed.keys()]);
  const receivables = [...parties]
    .map((p) => [p, summary?.profit.receivables[p] ?? 0] as const)
    .sort((a, b) => b[1] - a[1]);
  return (
    <Card title="Credit book" hint="udhaar outstanding · disputes in suspense">
      {conflicts.map((c) => (
        <ConflictRow key={c.ids.join()} c={c} onChange={onChange} />
      ))}
      {conflicts.length > 0 && <div style={{ height: 12 }} />}
      {receivables.length === 0 ? (
        <div className="empty">No one owes anything.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th className="num">Owes</th>
            </tr>
          </thead>
          <tbody>
            {receivables.map(([party, amt]) => {
              const d = disputed.get(party);
              return (
                <tr key={party}>
                  <td>
                    <span style={{ textTransform: "capitalize" }}>{party}</span>
                    {d && (
                      <span className="badge credit_given" style={{ marginLeft: 8 }}>
                        {d.kind === "credit_paid" ? `${rupees(d.paise)} payment disputed` : `+${rupees(d.paise)} disputed`}
                      </span>
                    )}
                  </td>
                  <td className={`num ${amt < 0 ? "pos" : ""}`}>
                    {amt < 0 ? `paid ${inr(-amt)} extra` : amt === 0 ? <span className="muted">settled</span> : inr(amt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ConflictRow({ c, onChange }: { c: Summary["conflicts"][number]; onChange: () => void }) {
  const [custom, setCustom] = useState("");
  const { busy, error, run } = useAction();
  const [lo, hi] = c.claims_paise.map((p) => p / 100);
  const settle = async (amt: number) => {
    if (await run(() => api.resolve(c.ids, amt))) onChange();
  };
  return (
    <div className="conflict stack" style={{ gap: 6 }}>
      <div>
        <b style={{ textTransform: "capitalize" }}>{c.party}</b>{" "}
        {c.kind === "credit_paid" ? "paid" : "took on credit"}: devices disagree — <b>{inr(lo)}</b> vs <b>{inr(hi)}</b>
      </div>
      <div className="small">
        Booked {inr(lo)} as certain, <b>{rupees(c.suspense_paise)}</b> parked in suspense. Books stay balanced.
      </div>
      <div className="row">
        <span className="small muted">Settle:</span>
        <button className="btn sm" disabled={busy} onClick={() => settle(lo)}>{inr(lo)}</button>
        <button className="btn sm" disabled={busy} onClick={() => settle(hi)}>{inr(hi)}</button>
        <input className="input" style={{ width: 90 }} placeholder="other ₹" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button className="btn sm" disabled={busy || !custom} onClick={() => settle(Number(custom))}>Set</button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

const ORDER = ["cash", "inventory", "receivable", "suspense", "revenue", "expense"];

export function TrialBalance({ summary }: { summary: Summary | null }) {
  const rows = Object.entries(summary?.balances_paise ?? {})
    .filter(([, v]) => v !== 0)
    .sort(([a], [b]) => ORDER.indexOf(a.split(":")[0]) - ORDER.indexOf(b.split(":")[0]) || a.localeCompare(b));
  const debit = rows.reduce((s, [, v]) => s + Math.max(v, 0), 0);
  const credit = rows.reduce((s, [, v]) => s + Math.max(-v, 0), 0);
  return (
    <Card
      title="Trial balance"
      hint="double-entry over the fused view"
      right={summary && <span className={`chip ${summary.balanced ? "good" : "bad"}`}>{summary.balanced ? "balanced" : "unbalanced"}</span>}
    >
      {rows.length === 0 ? (
        <div className="empty">No postings yet.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([acct, v]) => (
                <tr key={acct}>
                  <td><code>{acct}</code></td>
                  <td className="num">{v > 0 ? rupees(v) : ""}</td>
                  <td className="num">{v < 0 ? rupees(-v) : ""}</td>
                </tr>
              ))}
              <tr>
                <td><b>Total</b></td>
                <td className="num"><b>{rupees(debit)}</b></td>
                <td className="num"><b>{rupees(credit)}</b></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
