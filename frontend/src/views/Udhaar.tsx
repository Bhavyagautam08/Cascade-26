import { useState } from "react";
import { api, Conflict, inr, rupees } from "../api";
import type { Data } from "../App";
import { cap } from "../derive";
import { Empty, ErrorLine, Panel, Skeleton, useAction, ViewHead } from "../ui";

export default function Udhaar(d: Data) {
  const { summary } = d;
  const conflicts = summary?.conflicts ?? [];
  // Receivables are the certain part only; a disputed difference waits in suspense.
  const disputed = new Map(conflicts.map((c) => [c.party, c]));
  const receivable = summary?.receivables ?? {}; // cumulative: a debt carries across days
  const parties = [...new Set([...Object.keys(receivable), ...disputed.keys()])]
    .map((p) => ({ party: p, owes: receivable[p] ?? 0 }))
    .sort((a, b) => b.owes - a.owes);
  const total = parties.reduce((s, p) => s + Math.max(p.owes, 0), 0);
  const debtors = parties.filter((p) => p.owes > 0).length;

  return (
    <>
      <ViewHead
        title="Udhaar book"
        line={
          !summary
            ? "Reading the ledger…"
            : conflicts.length
              ? `${conflicts.length} ${conflicts.length === 1 ? "amount is" : "amounts are"} disputed between phones. The books stay balanced while ${conflicts.length === 1 ? "it waits" : "they wait"} for you.`
              : debtors
                ? `${debtors} ${debtors === 1 ? "customer owes" : "customers owe"} ${inr(total)} in all.`
                : "Nobody owes the stall anything."
        }
      />
      <div className="grid">
        {conflicts.length > 0 && (
          <Panel title="Settle a dispute" note="Two phones heard different amounts at the same time. The smaller one is booked; the gap waits in suspense." className="span-12">
            <ul className="rows disputes">
              {conflicts.map((c) => <Dispute key={c.ids.join()} c={c} onDone={d.refresh} />)}
            </ul>
          </Panel>
        )}
        <Panel
          title="Who owes what"
          className="span-7"
          aside={summary && <b className="money">{inr(total)}</b>}
          note="Expected to come back; about 1 rupee in 5 of old udhaar usually doesn't, and the profit range counts that."
        >
          {!summary ? (
            <div className="stack-8"><Skeleton /><Skeleton w="70%" /></div>
          ) : parties.length === 0 ? (
            <Empty>No udhaar given or repaid yet.</Empty>
          ) : (
            <table className="data">
              <thead><tr><th>Customer</th><th className="num">Owes</th></tr></thead>
              <tbody>
                {parties.map(({ party, owes }) => {
                  const c = disputed.get(party);
                  return (
                    <tr key={party}>
                      <td>
                        <b>{cap(party)}</b>
                        {c && <small className="sub">{rupees(c.suspense_paise)} {c.kind === "credit_paid" ? "of a payment" : "more udhaar"} disputed</small>}
                      </td>
                      <td className="num">
                        {owes > 0 ? <b className="money">{inr(owes)}</b> : owes < 0 ? <span className="money">paid {inr(-owes)} ahead</span> : <span className="dash">settled</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="How udhaar is booked" className="span-5">
          <ul className="rows explain">
            <li><b>Given:</b> “Pandey ji ka 60 udhaar likh” adds ₹60 to what Pandey owes and counts as a sale.</li>
            <li><b>Repaid:</b> “Sharma ji ka 40 jama kar” moves ₹40 from what Sharma owes into cash.</li>
            <li><b>Disputed:</b> if two phones disagree, the lower amount is booked and the gap waits in suspense until you settle it above.</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}

function Dispute({ c, onDone }: { c: Conflict; onDone: () => void }) {
  const [other, setOther] = useState("");
  const { busy, error, run } = useAction();
  const [lo, hi] = c.claims_paise.map((p) => p / 100);
  const settle = async (amt: number) => {
    if (await run(() => api.resolve(c.ids, amt))) onDone();
  };
  return (
    <li className="dispute">
      <div className="row-main">
        <b>
          {cap(c.party)} {c.kind === "credit_paid" ? "paid" : "took on udhaar"}: {inr(lo)} or {inr(hi)}?
        </b>
        <small>
          {c.ids.join(" and ")} disagree. {inr(lo)} is booked, {rupees(c.suspense_paise)} waits in suspense.
        </small>
      </div>
      <div className="dispute-actions">
        <button className="btn" disabled={busy} onClick={() => settle(lo)}>It was {inr(lo)}</button>
        <button className="btn" disabled={busy} onClick={() => settle(hi)}>It was {inr(hi)}</button>
        <span className="joined">
          <input
            className="input num"
            inputMode="decimal"
            aria-label="Another amount in rupees"
            placeholder="Other ₹"
            value={other}
            onChange={(e) => setOther(e.target.value)}
          />
          <button className="btn" disabled={busy || !other || isNaN(Number(other))} onClick={() => settle(Number(other))}>Set</button>
        </span>
      </div>
      <ErrorLine error={error} />
    </li>
  );
}
