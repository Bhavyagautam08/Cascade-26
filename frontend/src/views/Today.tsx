import { useEffect, useState } from "react";
import { api, inr, rupees, Summary, Transcript } from "../api";
import type { Data } from "../App";
import { amountText, cap, dayLabel, doubtful, onDay, pct, standing, what } from "../derive";
import { Icon } from "../icons";
import { Conf, Empty, KindTag, Panel, Skeleton, ViewHead } from "../ui";
import { useLedgerStock, worstWaste } from "./Stock";

export default function Today(d: Data) {
  const { summary, events } = d;
  const [newDayError, setNewDayError] = useState<string | null>(null);
  const today = onDay(events, summary?.day.index).filter((e) => e.kind !== "day_start");

  async function startNewDay() {
    if (!window.confirm("Start a new day?\n\nToday's view starts empty. Nothing is deleted: earlier days stay in the ledger, and udhaar and the books carry over.\nThe family's other phones join the new day when they next sync.")) return;
    try {
      await api.newDay();
      setNewDayError(null);
      d.refresh();
    } catch (e) {
      setNewDayError(`Could not start a new day: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const unsure = doubtful(today, summary);
  const conflicts = summary?.conflicts ?? [];

  // The one finding, read first: what needs the vendor, else what the worker did.
  let line: string;
  if (!summary) line = "Reading the ledger…";
  else if (conflicts.length)
    line = `${rupees(conflicts[0].suspense_paise)} of ${cap(conflicts[0].party)}'s ${
      conflicts[0].kind === "credit_paid" ? "payment" : "udhaar"
    } is disputed between two phones. It waits in suspense until you settle it.`;
  else if (unsure.length) line = `${unsure.length} ${unsure.length === 1 ? "entry was" : "entries were"} hard to hear. Check ${unsure.length === 1 ? "it" : "them"} before the day closes.`;
  else if (!today.length) line = "Nothing booked today yet. Say a trade near the phone, or type it in.";
  else line = `Nothing needs you. The worker has booked ${today.length} ${today.length === 1 ? "entry" : "entries"} today and the books balance.`;

  return (
    <>
      <ViewHead
        title={`Today · ${dayLabel(summary?.day)}`}
        line={<>{line}{newDayError && <span className="warn"> {newDayError}</span>}</>}
        actions={
          <>
            <button className="btn" onClick={startNewDay} title="Today's view starts empty; earlier days stay in the ledger">
              Start a new day
            </button>
            <a className="btn primary" href="#/record">
              <Icon.record /> Record a trade
            </a>
          </>
        }
      />
      <div className="grid">
        <ProfitCard summary={summary} />
        <div className="col span-4">
          <NeedsYou d={d} unsure={unsure} />
          <Listening d={d} />
        </div>
        <Chain d={d} />
        <Booked d={d} today={today} />
        <ToCollect d={d} />
      </div>
    </>
  );
}

function ProfitCard({ summary }: { summary: Summary | null }) {
  if (!summary)
    return (
      <Panel title="What the stall really earned" className="span-8">
        <div className="stack-8">
          <Skeleton w={260} h={36} />
          <Skeleton w="70%" />
          <Skeleton w="100%" h={48} />
          <Skeleton w="100%" h={150} />
        </div>
      </Panel>
    );
  const { p10, p50, p90, components: c } = summary.profit;
  return (
    <Panel
      title="What the stall really earned"
      note="Accrual profit, counting udhaar as income and unsold stock as stock"
      className="span-8"
      aside={<a className="link" href="#/books">See the books</a>}
    >
      <div className="figure-lead">
        <span className="money xl">{inr(p10)}</span>
        <span className="to">to</span>
        <span className="money xl">{inr(p90)}</span>
      </div>
      <p className="figure-sub">
        8 in 10 likely, most likely <b className="money">{inr(p50)}</b>. Shaky entries widen the range instead of hiding in it.
      </p>
      <RangePlot p10={p10} p50={p50} p90={p90} />
      <dl className="ledger-lines">
        <div><dt>Sales, cash and udhaar</dt><dd className="money">{inr(c.revenue)}</dd></div>
        <div><dt>Stock used up <small>(up to 30% of what was bought may still be on the cart)</small></dt><dd className="money">−{inr(c.cogs)}</dd></div>
        <div><dt>Expenses</dt><dd className="money">{c.expenses ? `−${inr(c.expenses)}` : inr(0)}</dd></div>
        <div><dt>Udhaar that may never come back</dt><dd className="money">{c.expected_bad_debt ? `−${inr(c.expected_bad_debt)}` : inr(0)}</dd></div>
      </dl>
    </Panel>
  );
}

/** The likely range on a scale with ₹0 marked: the band is the one chart hue on the screen. */
function RangePlot({ p10, p50, p90 }: { p10: number; p50: number; p90: number }) {
  const lo = Math.min(p10, 0);
  const hi = Math.max(p90, 0);
  const pad = Math.max((hi - lo) * 0.1, 10);
  const x = (v: number) => ((v - (lo - pad)) / (hi - lo + 2 * pad)) * 100;
  return (
    <div className="range" role="img" aria-label={`Likely profit from ${inr(p10)} to ${inr(p90)}, most likely ${inr(p50)}`}>
      <div className="range-track" />
      <div className="range-band" style={{ left: `${x(p10)}%`, width: `${x(p90) - x(p10)}%` }} />
      <div className="range-mid" style={{ left: `${x(p50)}%` }} />
      <div className="range-zero" style={{ left: `${x(0)}%` }}>
        <span>₹0</span>
      </div>
    </div>
  );
}

function NeedsYou({ d, unsure }: { d: Data; unsure: Data["events"] }) {
  const conflicts = d.summary?.conflicts ?? [];
  const rows = [
    ...conflicts.map((c) => ({
      key: c.ids.join(),
      href: "#/udhaar",
      title: `Settle ${cap(c.party)}'s ${c.kind === "credit_paid" ? "payment" : "udhaar"}`,
      sub: `Phones say ${inr(c.claims_paise[0] / 100)} and ${inr(c.claims_paise[1] / 100)}`,
      tone: "warning" as const,
    })),
    ...unsure.map((e) => ({
      key: e.id,
      href: `#/entries/${encodeURIComponent(e.id)}`,
      title: `Check: ${what(e)}`,
      sub: `${pct(e.confidence)} sure · "${(e.raw ?? "").slice(0, 48)}${(e.raw ?? "").length > 48 ? "…" : ""}"`,
      tone: "neutral" as const,
    })),
  ];
  const shown = rows.slice(0, 5);
  return (
    <Panel title="Needs you" aside={rows.length > 5 ? <span className="muted num">{rows.length}</span> : undefined}>
      {!d.summary ? (
        <div className="stack-8"><Skeleton w="80%" /><Skeleton w="60%" /></div>
      ) : shown.length === 0 ? (
        <Empty>
          <Icon.check /> Nothing to settle or check.
        </Empty>
      ) : (
        <ul className="rows">
          {shown.map((r) => (
            <li key={r.key}>
              <a className="row-link" href={r.href}>
                <span className="row-main">
                  <b>{r.title}</b>
                  <small>{r.sub}</small>
                </span>
                <Icon.chevron />
              </a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The evaluation chain, one figure per link, each opening the view that computes it. */
function Chain({ d }: { d: Data }) {
  const { summary, events } = d;
  const stock = useLedgerStock(events);
  const bought = Object.entries(summary?.balances_paise ?? {})
    .filter(([a]) => a.startsWith("inventory:"))
    .reduce((s, [, v]) => s + v, 0);
  const owed = Object.values(summary?.receivables ?? {}).reduce((s, v) => s + Math.max(v, 0), 0);
  const suspense = (summary?.conflicts ?? []).reduce((s, c) => s + c.suspense_paise, 0);
  const p = summary?.profit;
  const worst = stock.data ? worstWaste(stock.data) : null;
  const cells = [
    { href: "#/stock", label: "Stock on the books", value: summary ? rupees(bought) : null, sub: "raw material, all days" },
    {
      href: "#/stock",
      label: "Waste nobody sold",
      value: stock.error ? "could not compute" : !stock.data ? null : worst ? worst.headline : "not yet",
      sub: stock.error ?? (worst ? worst.sub : "needs morning and evening counts on a few days"),
    },
    { href: "#/udhaar", label: "Udhaar owed to you", value: summary ? inr(owed) : null, sub: suspense ? `${rupees(suspense)} still disputed` : "no disputes" },
    { href: "#/books", label: "Today's true profit", value: p ? `${inr(p.p10)} – ${inr(p.p90)}` : null, sub: p ? `most likely ${inr(p.p50)}` : "" },
  ];
  return (
    <section className="panel span-12 chain" aria-label="From stock to profit">
      {cells.map((c) => (
        <a key={c.label} className="chain-cell" href={c.href}>
          <span className="chain-label">{c.label}</span>
          {c.value == null ? <Skeleton w={120} h={22} /> : <b className="money lg">{c.value}</b>}
          <small>{c.sub}</small>
        </a>
      ))}
    </section>
  );
}

/** The worker's output: what was said, and the lines it booked from it. */
function Booked({ d, today }: { d: Data; today: Data["events"] }) {
  const { events, summary } = d;
  const { superseded } = standing(events, summary);
  const recent = [...today].reverse().filter((e) => e.kind !== "adjustment").slice(0, 6);
  return (
    <Panel
      title="What the worker booked today"
      note="Newest first. Each line shows what was said and how it went into the books."
      className="span-8"
      aside={today.length > 6 ? <a className="link" href="#/entries">All {today.length} of today</a> : undefined}
    >
      {!d.loaded ? (
        <div className="stack-8"><Skeleton /><Skeleton w="70%" /><Skeleton w="80%" /></div>
      ) : recent.length === 0 ? (
        <Empty>Nothing booked yet. <a className="link" href="#/record">Record the first trade</a>.</Empty>
      ) : (
        <ul className="rows booked">
          {recent.map((e) => (
            <li key={e.id} className={superseded.has(e.id) ? "gone" : ""}>
              <a className="row-link" href={`#/entries/${encodeURIComponent(e.id)}`}>
                <span className="row-main">
                  <span className="booked-line">
                    <KindTag kind={e.kind} />
                    <span>{what(e)}</span>
                  </span>
                  {e.raw && <small className="said">“{e.raw}”</small>}
                </span>
                <span className="row-end">
                  <b className="money">{amountText(e)}</b>
                  <Conf value={e.confidence} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Listening({ d }: { d: Data }) {
  const [feed, setFeed] = useState<Transcript[] | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => api.recentTranscripts().then((f) => alive && setFeed(f)).catch(() => {});
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const on = d.health?.mic_listening;
  return (
    <Panel
      title="Listening"
      aside={<span className={`status ${on ? "on" : ""}`}><span className="dot" aria-hidden="true" />{on ? "Mic on" : "Mic off"}</span>}
      note={on ? "Only words are kept, never the audio." : "This phone is not listening. The main phone usually is."}
    >
      {feed == null ? (
        <div className="stack-8"><Skeleton /><Skeleton w="60%" /></div>
      ) : feed.length === 0 ? (
        <Empty>Nothing heard yet today.</Empty>
      ) : (
        <ul className="rows">
          {[...feed].reverse().slice(0, 5).map((u, i) => (
            <li key={i} className="heard">
              <span className="row-main">
                <span>{u.text}</span>
                <small>
                  {u.events ? `${u.events} ${u.events === 1 ? "entry" : "entries"} booked` : "Small talk, nothing booked"} · {pct(u.confidence)} clear
                </small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ToCollect({ d }: { d: Data }) {
  const owed = Object.entries(d.summary?.receivables ?? {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <Panel title="Udhaar to collect" className="span-4" aside={owed.length > 5 ? <a className="link" href="#/udhaar">All {owed.length}</a> : undefined}>
      {!d.summary ? (
        <Skeleton />
      ) : owed.length === 0 ? (
        <Empty>Nobody owes the stall anything.</Empty>
      ) : (
        <ul className="rows">
          {owed.slice(0, 5).map(([party, v]) => (
            <li key={party} className="kv">
              <span>{cap(party)}</span>
              <b className="money">{inr(v)}</b>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
