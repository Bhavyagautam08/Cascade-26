import { inr, LedgerEvent, rupees } from "../api";
import type { Data } from "../App";
import { grossPaise, SOURCE_LABEL, what } from "../derive";
import { Conf, Empty, KindTag, Panel, Skeleton, ViewHead } from "../ui";

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
          note="The same trade heard, texted and tallied is one trade. More witnesses make it surer."
        >
          {!summary ? (
            <Skeleton />
          ) : groups.length === 0 ? (
            <Empty>No trade has come in twice yet. Type one, then send the same one with “An SMS” as its source.</Empty>
          ) : (
            <ul className="rows">
              {groups.map((g) => {
                const combined = 1 - g.reduce((miss, e) => miss * (1 - e.confidence), 1);
                const best = g.reduce((a, b) => (b.confidence > a.confidence ? b : a));
                return (
                  <li key={g.map((e) => e.id).join()} className="fused">
                    <div className="booked-line">
                      <KindTag kind={best.kind} />
                      <span>{what(best)}</span>
                      <b className="money push">{inr(grossPaise(best) / 100)}</b>
                    </div>
                    <ul className="witnesses">
                      {g.map((e) => (
                        <li key={e.id}>
                          <a className="link" href={`#/entries/${encodeURIComponent(e.id)}`}>{SOURCE_LABEL[e.source] ?? e.source}</a>
                          <span className="said">“{e.raw}”</span>
                          <Conf value={e.confidence} />
                        </li>
                      ))}
                    </ul>
                    <div className="kv"><span>Together</span><Conf value={combined} /></div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
