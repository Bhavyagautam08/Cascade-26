import { useState } from "react";
import { api, LedgerEvent, rupees } from "../api";
import type { Data } from "../App";
import { amountText, KIND_LABEL, SOURCE_LABEL, standing, wallClock, what } from "../derive";
import { Conf, Empty, ErrorLine, KindTag, Panel, Pill, Segmented, Skeleton, useAction, ViewHead } from "../ui";

type Filter = "all" | "trade" | "udhaar" | "check" | "corrections";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "trade", label: "Bought and sold" },
  { value: "udhaar", label: "Udhaar" },
  { value: "check", label: "To check" },
  { value: "corrections", label: "Corrections" },
];

export default function Entries(d: Data & { selected?: string }) {
  const { events, summary } = d;
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(30);
  const st = standing(events, summary);

  const match = (e: LedgerEvent) =>
    filter === "all" ||
    (filter === "trade" && ["purchase", "sale", "expense", "stock_count", "order"].includes(e.kind)) ||
    (filter === "udhaar" && (e.kind === "credit_given" || e.kind === "credit_paid")) ||
    (filter === "check" && e.kind !== "adjustment" && !st.superseded.has(e.id) && (e.confidence < 0.6 || st.disputed.has(e.id))) ||
    (filter === "corrections" && (e.kind === "adjustment" || e.supersedes.length > 0 || st.superseded.has(e.id)));
  const rows = [...events].reverse().filter(match);
  const sel = events.find((e) => e.id === d.selected) ?? null;

  return (
    <>
      <ViewHead
        title="Entries"
        line={`${events.length} ${events.length === 1 ? "entry" : "entries"}, oldest kept forever. Ordered by what each phone had seen, never by its clock.`}
      />
      <div className="toolbar">
        <Segmented label="Show" value={filter} options={FILTERS} onChange={(f) => (setFilter(f), setLimit(30))} />
        <span className="muted num">{rows.length} shown</span>
      </div>
      <div className={`grid ${sel ? "with-detail" : ""}`}>
        <Panel title={FILTERS.find((f) => f.value === filter)!.label} className={sel ? "span-7" : "span-12"}>
          {!d.loaded ? (
            <div className="stack-8"><Skeleton /><Skeleton w="80%" /><Skeleton w="90%" /></div>
          ) : rows.length === 0 ? (
            <Empty>{events.length ? "No entries of this kind." : <>Nothing recorded yet. <a className="link" href="#/record">Record a trade</a>.</>}</Empty>
          ) : (
            <div className="table-scroll">
              <table className="data entries">
                <thead>
                  <tr>
                    <th>Entry</th>
                    <th className="num">Amount</th>
                    <th className="hide-sm">From</th>
                    <th className="num hide-sm">Sure</th>
                    <th className="hide-md">Phone clock</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, limit).map((e) => {
                    const gone = st.superseded.get(e.id);
                    const clock = wallClock(e.wall_time);
                    return (
                      <tr
                        key={e.id}
                        className={`${gone ? "gone" : ""} ${sel?.id === e.id ? "selected" : ""}`}
                        onClick={() => d.go("entries", sel?.id === e.id ? undefined : e.id)}
                      >
                        <td>
                          <a className="entry-cell" href={`#/entries/${encodeURIComponent(e.id)}`} onClick={(ev) => ev.stopPropagation()}>
                            <span className="booked-line">
                              <KindTag kind={e.kind} />
                              <span>{what(e)}</span>
                            </span>
                            <small className="marks">
                              <code>{e.id}</code>
                              {st.fusedWith.has(e.id) && <Pill title="Seen on more than one channel, counted once">counted once</Pill>}
                              {st.disputed.has(e.id) && <Pill tone="warning">disputed</Pill>}
                              {gone && <Pill>{gone}</Pill>}
                            </small>
                          </a>
                        </td>
                        <td className="num"><b className="money">{amountText(e)}</b></td>
                        <td className="hide-sm">{SOURCE_LABEL[e.source] ?? e.source}</td>
                        <td className="num hide-sm"><Conf value={e.confidence} /></td>
                        <td className={`hide-md ${clock.bad ? "clock-bad" : "muted"}`} title={clock.bad ? "This phone's clock is wrong. It is ignored for ordering." : undefined}>
                          {clock.text}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {rows.length > limit && (
            <button className="btn quiet" onClick={() => setLimit((l) => l + 50)}>
              Show {Math.min(50, rows.length - limit)} more of {rows.length}
            </button>
          )}
        </Panel>
        {sel && <Detail e={sel} d={d} />}
      </div>
    </>
  );
}

function Detail({ e, d }: { e: LedgerEvent; d: Data }) {
  const { busy, error, run } = useAction();
  const st = standing(d.events, d.summary);
  const gone = st.superseded.get(e.id);
  const by = d.events.find((x) => x.supersedes.includes(e.id));
  const sum = e.postings.reduce((s, p) => s + p.amount, 0);
  const clock = wallClock(e.wall_time);
  const group = st.fusedWith.get(e.id);

  async function voidIt() {
    if (!window.confirm(`Withdraw “${what(e)}”? It stays in the history but stops counting.`)) return;
    if (await run(() => api.void(e.id))) d.refresh();
  }

  return (
    <Panel
      title={`${KIND_LABEL[e.kind] ?? e.kind}: ${what(e)}`}
      className="span-5 detail"
      aside={<a className="link" href="#/entries">Close</a>}
    >
      <dl className="facts">
        <div><dt>Amount</dt><dd className="money">{amountText(e)}</dd></div>
        <div><dt>Came in by</dt><dd>{SOURCE_LABEL[e.source] ?? e.source} on {e.device_id}</dd></div>
        <div><dt>How sure</dt><dd><Conf value={e.confidence} /></dd></div>
        {e.raw && <div><dt>Said or written</dt><dd>“{e.raw}”</dd></div>}
        {gone && by && (
          <div>
            <dt>Status</dt>
            <dd>{gone === "voided" ? "Withdrawn" : "Replaced"} by <a className="link" href={`#/entries/${encodeURIComponent(by.id)}`}><code>{by.id}</code></a></dd>
          </div>
        )}
        {group && (
          <div>
            <dt>Counted once with</dt>
            <dd>{group.filter((id) => id !== e.id).map((id) => <a key={id} className="link" href={`#/entries/${encodeURIComponent(id)}`}><code>{id}</code></a>)}</dd>
          </div>
        )}
        {e.supersedes.length > 0 && (
          <div>
            <dt>Replaces</dt>
            <dd>{e.supersedes.map((id) => <a key={id} className="link" href={`#/entries/${encodeURIComponent(id)}`}><code>{id}</code></a>)}</dd>
          </div>
        )}
      </dl>

      <h3 className="sub-head">Double entry</h3>
      {e.postings.length === 0 ? (
        <p className="hint">No lines: {e.kind === "adjustment" ? "this entry withdraws the one it replaces." : "no amount was heard, so nothing was booked."}</p>
      ) : (
        <table className="data">
          <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
          <tbody>
            {e.postings.map((p, i) => (
              <tr key={i}>
                <td><code>{p.account}</code></td>
                <td className="num">{p.amount > 0 ? rupees(p.amount) : ""}</td>
                <td className="num">{p.amount < 0 ? rupees(-p.amount) : ""}</td>
              </tr>
            ))}
            <tr className="total">
              <td>Balance</td>
              <td colSpan={2} className="num">{sum === 0 ? "₹0, balanced" : rupees(sum)}</td>
            </tr>
          </tbody>
        </table>
      )}

      <h3 className="sub-head">Place in history</h3>
      <p className="hint">What each phone had booked when this was written. This decides the order, not the clock.</p>
      <div className="chips">
        {Object.entries(e.vclock).sort().map(([dev, n]) => (
          <span key={dev} className="chip"><code>{dev}</code> <span className="num">{n}</span></span>
        ))}
      </div>
      <p className="hint">
        Phone clock said <span className={clock.bad ? "clock-bad" : ""}>{e.wall_time == null ? "nothing" : new Date(e.wall_time * 1000).toISOString().replace("T", " ").slice(0, 19)}</span>
        {clock.bad ? ", which is wrong and ignored." : ". Shown, never trusted."}
      </p>

      {!gone && e.kind !== "adjustment" && (
        <div className="detail-actions">
          <button className="btn danger" disabled={busy} onClick={voidIt}>Withdraw this entry</button>
        </div>
      )}
      <ErrorLine error={error} />
    </Panel>
  );
}
