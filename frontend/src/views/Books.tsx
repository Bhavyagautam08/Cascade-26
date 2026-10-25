import { api, inr, LedgerEvent, PossibleDuplicate, rupees } from "../api";
import type { Data } from "../App";
import { cap, deviceName, disputeSubject, grossPaise, isUdhaar, SOURCE_LABEL, what } from "../derive";
import { Conf, Empty, ErrorLine, KindTag, Panel, Skeleton, useAction, ViewHead } from "../ui";
import { Dispute } from "./Dispute";

const ORDER = ["cash", "inventory", "receivable", "suspense", "revenue", "expense"];
const ACCOUNT_NAME: Record<string, string> = {
  cash: "Cash in the box",
  inventory: "Stock",
  receivable: "Udhaar owed by",
  suspense: "Disputed, waiting",
  revenue: "Sales",
  expense: "Expense",
};

function accountLabel(acct: string) {
  const [head, rest] = acct.split(":");
  const name = ACCOUNT_NAME[head] ?? head;
  if (!rest || head === "revenue") return name;
  return `${name}${head === "receivable" ? " " : ": "}${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

export default function Books(d: Data) {
  const { summary, events } = d;
  const rows = Object.entries(summary?.balances_paise ?? {})
    .filter(([, v]) => v !== 0)
    .sort(([a], [b]) => ORDER.indexOf(a.split(":")[0]) - ORDER.indexOf(b.split(":")[0]) || a.localeCompare(b));
  const debit = rows.reduce((s, [, v]) => s + Math.max(v, 0), 0);
  const credit = rows.reduce((s, [, v]) => s + Math.max(-v, 0), 0);
  const byId = new Map(events.map((e) => [e.id, e]));
  const groups = (summary?.duplicates ?? []).map((ids) => ids.map((id) => byId.get(id)).filter((e): e is LedgerEvent => !!e));
  const heardDifferently = (summary?.conflicts ?? []).filter((c) => !(isUdhaar(c.kind) && c.party)); // udhaar: Udhaar view
  const twice = summary?.possible_duplicates ?? [];

  return (
    <>
      <ViewHead
        title="Books"
        line={
          !summary
            ? "Reading the ledger…"
            : summary.balanced
              ? `Debits and credits both come to ${rupees(debit)}. Every entry balances on its own, so any mix of phones' entries balances too.`
              : "Debits and credits do not match. Check the latest entries."
        }
      />
      <div className="grid">
        {heardDifferently.length > 0 && (
          <Panel title="Heard differently" className="span-12" note="One trade, two amounts, from two phones within seconds of each other. The lower one is booked until you say which it was.">
            <ul className="rows disputes">
              {heardDifferently.map((c) => <Dispute key={c.ids.join()} c={c} onDone={d.refresh} />)}
            </ul>
          </Panel>
        )}
        {twice.length > 0 && (
          <Panel title="One trade or two?" className="span-12" note="The same trade on two phones that were out of touch, so the app can't tell. Both count until you decide.">
            <ul className="rows disputes">
              {twice.map((p) => <MaybeTwice key={p.ids.join()} p={p} byId={byId} onDone={d.refresh} />)}
            </ul>
          </Panel>
        )}
        <Panel
          title="Trial balance"
          className="span-7"
          note="Duplicates counted once, disputes in suspense."
          aside={summary && <span className={`status ${summary.balanced ? "on" : "bad"}`}><span className="dot" aria-hidden="true" />{summary.balanced ? "Balanced" : "Not balanced"}</span>}
        >
          {!summary ? (
            <div className="stack-8"><Skeleton /><Skeleton w="80%" /></div>
          ) : rows.length === 0 ? (
            <Empty>No money has moved yet.</Empty>
          ) : (
            <table className="data">
              <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
              <tbody>
                {rows.map(([acct, v]) => (
                  <tr key={acct}>
                    <td>{accountLabel(acct)} <small className="sub"><code>{acct}</code></small></td>
                    <td className="num money">{v > 0 ? rupees(v) : ""}</td>
                    <td className="num money">{v < 0 ? rupees(-v) : ""}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Total</td>
                  <td className="num money">{rupees(debit)}</td>
                  <td className="num money">{rupees(credit)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </Panel>
        <Panel
          title="Counted once"
          className="span-5"
          note="The same trade heard, texted and tallied, or heard by two phones at once, is one trade. If two of these were really separate trades, say so."
        >
          {!summary ? (
            <Skeleton />
          ) : groups.length === 0 ? (
            <Empty>No trade has come in twice yet. Type one, then send the same one with “An SMS” as its source.</Empty>
          ) : (
            <ul className="rows">
              {groups.map((g) => <CountedOnce key={g.map((e) => e.id).join()} g={g} onDone={d.refresh} />)}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

/** One witness per source counts: a second phone's ear is not independent evidence (fusion.py). */
function CountedOnce({ g, onDone }: { g: LedgerEvent[]; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const perSource = new Map(g.map((e) => [e.source, e]));
  const combined = 1 - [...perSource.values()].reduce((miss, e) => miss * (1 - e.confidence), 1);
  const best = g.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  const together = perSource.size > 1 ? combined : best.confidence;
  return (
    <li className="fused">
      <div className="booked-line">
        <KindTag kind={best.kind} />
        <span>{what(best)}</span>
        <b className="money push">{inr(grossPaise(best) / 100)}</b>
      </div>
      <ul className="witnesses">
        {g.map((e) => (
          <li key={e.id}>
            <a className="link" href={`#/entries/${encodeURIComponent(e.id)}`}>{SOURCE_LABEL[e.source] ?? e.source}</a>
            <span className="muted">{deviceName(e.device_id)}</span>
            <span className="said">“{e.raw}”</span>
            <Conf value={e.confidence} />
          </li>
        ))}
      </ul>
      <div className="kv">
        <span>Together</span>
        <Conf value={together} />
      </div>
      <div className="dispute-actions">
        <button className="btn" disabled={busy} onClick={async () => (await run(() => api.separate(g.map((e) => e.id)))) && onDone()}>
          These are different trades
        </button>
      </div>
      <ErrorLine error={error} />
    </li>
  );
}

function MaybeTwice({ p, byId, onDone }: { p: PossibleDuplicate; byId: Map<string, LedgerEvent>; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const decide = async (fn: (ids: string[]) => Promise<unknown>) => {
    if (await run(() => fn(p.ids))) onDone();
  };
  return (
    <li className="dispute">
      <div className="row-main">
        <b>
          {cap(disputeSubject(p))} of {inr(p.amount_paise / 100)}: once or twice?
        </b>
        <small>
          {p.ids.map((id) => `${deviceName(id.split(":")[0])} heard “${byId.get(id)?.raw ?? id}”`).join("; ")}. {p.why}.
        </small>
      </div>
      <div className="dispute-actions">
        <button className="btn" disabled={busy} onClick={() => decide(api.same)}>One trade, count it once</button>
        <button className="btn" disabled={busy} onClick={() => decide(api.separate)}>Two trades</button>
      </div>
      <ErrorLine error={error} />
    </li>
  );
}
