import { useState } from "react";
import { api, Conflict, inr, rupees } from "../api";
import { cap, deviceName, disputeSubject, isUdhaar } from "../derive";
import { ErrorLine, useAction } from "../ui";

/** One trade heard with two amounts. The lower one is booked until the vendor says which it was. */
export function Dispute({ c, onDone }: { c: Conflict; onDone: () => void }) {
  const [other, setOther] = useState("");
  const { busy, error, run } = useAction();
  const [lo, hi] = c.claims_paise.map((p) => p / 100);
  const settle = async (amt: number) => {
    if (await run(() => api.resolve(c.ids, amt))) onDone();
  };
  const phones = c.ids.map((id) => deviceName(id.split(":")[0]));
  return (
    <li className="dispute">
      <div className="row-main">
        <b>
          {cap(disputeSubject(c))}: {inr(lo)} or {inr(hi)}?
        </b>
        <small>
          {phones[0] === phones[1] ? c.ids.join(" and ") : `${phones[0]} and ${phones[1]}`} disagree ({c.why}). {inr(lo)} is booked
          {isUdhaar(c.kind) ? `, ${rupees(c.suspense_paise)} waits in suspense.` : " until you say which it was."}
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
