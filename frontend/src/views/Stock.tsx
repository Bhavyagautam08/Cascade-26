import { useEffect, useState } from "react";
import { api, Day, IngredientStock, LedgerEvent, LedgerStock, LossSplit, StockRow } from "../api";
import type { Data } from "../App";
import { cap, dayLabel, fmtQty, pct } from "../derive";
import { Empty, ErrorLine, Panel, Segmented, Skeleton, ViewHead } from "../ui";

// Everything on this screen is computed by the backend from the ledger's own stock counts
// (morning inventory, evening count), purchases and plates sold (/inference/ledger). Nothing is
// estimated here, and nothing is grouped by a phone's clock.

/** The backend's stock maths, refetched whenever the ledger changes. Errors are shown, not hidden. */
export function useLedgerStock(events: LedgerEvent[]) {
  const [data, setData] = useState<LedgerStock | null>(null);
  const [days, setDays] = useState<Day[]>([]);
  const [error, setError] = useState<string | null>(null);
  const key = `${events.length}:${events[events.length - 1]?.id ?? ""}`;
  useEffect(() => {
    let alive = true;
    Promise.all([api.ledgerStock(), api.days()])
      .then(([s, d]) => alive && (setData(s), setDays(d.days), setError(null)))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [key]);
  return { data, days, error };
}

/** The ingredient with the most stock unaccounted for by plates sold, across trading days. */
export function worstWaste(s: LedgerStock) {
  const ok = Object.entries(s.ingredients).filter(([, g]) => g.status === "ok" && g.unexplained != null);
  if (!ok.length) return null;
  const [name, g] = ok.reduce((a, b) => ((b[1].unexplained ?? 0) > (a[1].unexplained ?? 0) ? b : a));
  return { name, headline: `${(g.unexplained ?? 0).toFixed(2)} ${g.unit ?? ""} ${name}`, sub: `over ${g.periods} trading days` };
}

const amount = (v: number, unit: string | null) => (unit === "kg" ? `${Math.round(v * 1000)} g` : unit === "l" ? `${Math.round(v * 1000)} ml` : `${fmtQty(v)} ${unit ?? ""}`);

export default function Stock(d: Data) {
  const { data, days, error } = useLedgerStock(d.events);
  const names = Object.keys(data?.ingredients ?? {});
  const [pick, setPick] = useState<string | null>(null);
  const name = pick && names.includes(pick) ? pick : names[0] ?? null;
  const g = name ? data!.ingredients[name] : null;
  const worst = data ? worstWaste(data) : null;
  const dayOf = (i: number) => dayLabel(days.find((x) => x.index === i) ?? { index: i, date: null });

  const line = error
    ? "Couldn't read the stock figures."
    : !data
      ? "Reading the ledger…"
      : !names.length
        ? "No stock counts yet. Save the morning inventory and the evening count on Start your day."
        : worst
          ? `${cap(worst.headline)} went somewhere other than a plate ${worst.sub}.`
          : `Counted so far: ${names.join(", ")}. The recipe appears after enough trading days (morning and evening counts).`;

  return (
    <>
      <ViewHead title="Stock and waste" line={line} />
      <ErrorLine error={error} />
      {names.length > 1 && <Segmented label="Ingredient" value={name ?? ""} options={names.map((n) => ({ value: n, label: n }))} onChange={setPick} />}
      <div className="grid" style={{ marginTop: "var(--gap)" }}>
        {!data ? (
          <Panel title="Daily stock" className="span-12"><Skeleton w="100%" h={120} /></Panel>
        ) : !g || !name ? (
          <Panel title="Daily stock" className="span-12"><Empty>Nothing counted yet.</Empty></Panel>
        ) : (
          <>
            <PeriodsPanel name={name} g={g} dishes={data.dishes} dayOf={dayOf} />
            <RecipePanel data={data} />
            <OvernightPanel name={name} g={g} dayOf={dayOf} />
            <LossPanel name={name} g={g} />
          </>
        )}
      </div>
    </>
  );
}

const KIND_TEXT: Record<StockRow["kind"], string> = { trading: "Trading day", overnight: "Overnight", excluded: "Not summed" };

function PeriodsPanel({ name, g, dishes, dayOf }: { name: string; g: IngredientStock; dishes: string[]; dayOf: (i: number) => string }) {
  return (
    <Panel
      title={`${cap(name)}: count to count`}
      note="Used = what the earlier count showed + what was bought − what the next count showed. Morning to evening is a trading day; evening to the next morning is overnight."
      className="span-12"
    >
      {g.rows.length === 0 ? (
        <Empty>Only one count of {name} so far. The next count (evening, or tomorrow morning) gives the first period.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>From → to</th><th>Period</th><th className="num">Had</th><th className="num">Bought</th><th className="num">Left</th><th className="num">Used</th>
                {dishes.map((x) => <th key={x} className="num">{x} plates</th>)}
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r, i) => (
                <tr key={i} className={r.kind === "excluded" ? "doubt" : ""}>
                  <td>{dayOf(r.from_day)}{r.to_day !== r.from_day && <> → {dayOf(r.to_day)}</>}</td>
                  <td>{KIND_TEXT[r.kind]}{r.note && <small className="warn" style={{ display: "block" }}>{r.note}</small>}{r.start_kind === "stock_count" && r.kind === "trading" && r.from_day !== r.to_day && <small className="muted" style={{ display: "block" }}>no morning count: started from the last count</small>}</td>
                  <td className="num">{fmtQty(r.start_qty)} <small>{g.unit}</small></td>
                  <td className="num">{r.bought ? <>{fmtQty(r.bought)} <small>{g.unit}</small></> : <span className="dash">—</span>}</td>
                  <td className="num">{fmtQty(r.end_qty)} <small>{g.unit}</small></td>
                  <td className="num"><b>{r.burn == null ? "—" : <>{fmtQty(r.burn)} <small>{g.unit}</small></>}</b></td>
                  {dishes.map((x) => <td key={x} className="num">{r.plates[x] ? fmtQty(r.plates[x]) : <span className="dash">—</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {g.status !== "ok" && <p className="panel-foot">{cap(g.status)}.</p>}
    </Panel>
  );
}

function RecipePanel({ data }: { data: LedgerStock }) {
  const learned = Object.entries(data.ingredients).filter(([, g]) => g.status === "ok" && g.usage_per_dish);
  return (
    <Panel title="Recipe the worker learned" note="No recipe card: worked out from what each trading day used and what it sold." className="span-7">
      {learned.length === 0 ? (
        <Empty>Appears once an ingredient has enough trading days with morning and evening counts.</Empty>
      ) : (
        <>
          <ul className="rows">
            {data.dishes.map((dish) => {
              const parts = learned
                .map(([n, g]) => ({ n, v: g.usage_per_dish![dish] ?? 0, unit: g.unit }))
                .filter((p) => p.v > 0.0005)
                .map((p) => `${amount(p.v, p.unit)} ${p.n}`);
              return (
                <li key={dish} className="kv">
                  <span>1 plate of <b>{dish}</b></span>
                  <span className="num">{parts.join(" + ") || "nothing measurable"}</span>
                </li>
              );
            })}
          </ul>
          <p className="panel-foot">
            Steady waste per trading day: {learned.map(([n, g]) => `${amount(g.baseline_waste_per_period ?? 0, g.unit)} ${n}`).join(" · ")}
          </p>
        </>
      )}
    </Panel>
  );
}

function OvernightPanel({ name, g, dayOf }: { name: string; g: IngredientStock; dayOf: (i: number) => string }) {
  return (
    <Panel title="Overnight" note={`Evening count to next morning's count, with nothing sold in between.`} className="span-5">
      {g.overnight.length === 0 ? (
        <Empty>No overnight periods for {name} yet (needs an evening count and the next morning's).</Empty>
      ) : (
        <ul className="rows">
          {g.overnight.map((o, i) => (
            <li key={i} className="kv">
              <span>{dayOf(o.from_day)} → {dayOf(o.to_day)}</span>
              <b className="num">{o.change > 0 ? `${fmtQty(o.change)} ${g.unit} gone` : o.change < 0 ? `${fmtQty(-o.change)} ${g.unit} more` : "no change"}</b>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const CAUSES = [
  { key: "spoilage", label: "Spoiled" },
  { key: "theft", label: "Taken" },
  { key: "personal", label: "Eaten by family" },
] as const;

function LossPanel({ name, g }: { name: string; g: IngredientStock }) {
  const [temp, setTemp] = useState(32);
  const [away, setAway] = useState(0);
  const [family, setFamily] = useState(0);
  const [perishable, setPerishable] = useState<string[] | null>(null);
  const [loss, setLoss] = useState<LossSplit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kg = g.unexplained ?? 0;

  useEffect(() => {
    api.lexicon()
      .then((l) => setPerishable(Array.isArray(l.perishable) ? l.perishable : []))
      .catch((e) => setError(`Couldn't read which items spoil fast: ${e instanceof Error ? e.message : String(e)}`));
  }, []);
  const spoils = perishable?.includes(name) ?? false;

  useEffect(() => {
    if (g.status !== "ok" || perishable == null) return;
    const t = setTimeout(() => {
      api
        .loss(kg, { temperature_c: temp, unattended_hours: away, family_present: family, perishable: spoils })
        .then((r) => (setLoss(r), setError(null)))
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }, 150);
    return () => clearTimeout(t);
  }, [g.status, kg, temp, away, family, spoils, perishable]);

  return (
    <Panel title="Where the waste went" note="A spread of likely causes, not a verdict. Tell the worker about today and the split moves." className="span-12">
      {g.status !== "ok" ? (
        <Empty>Appears once the recipe for {name} is known.</Empty>
      ) : (
        <div className="loss">
          <div className="loss-controls">
            <p className="loss-total">
              <b className="money lg">{fmtQty(kg)} {g.unit}</b> of {name} unexplained by plates sold{spoils ? ", and it spoils fast" : ""}
            </p>
            <Slider label="Hottest it got" value={temp} min={15} max={48} unit="°C" onChange={setTemp} />
            <Slider label="Cart left alone" value={away} min={0} max={10} unit="hours a day" onChange={setAway} />
            <Slider label="Family eating at the cart" value={family} min={0} max={6} unit={family === 1 ? "person" : "people"} onChange={setFamily} />
          </div>
          <div className="loss-result">
            <ErrorLine error={error} />
            {!loss ? (
              <Skeleton w="100%" h={20} />
            ) : (
              <>
                <div className="stacked" role="img" aria-label={CAUSES.map((c) => `${c.label} ${pct(loss.split[c.key].p)}`).join(", ")}>
                  {CAUSES.map((c, i) => <i key={c.key} className={`seg s${i}`} style={{ flexGrow: loss.split[c.key].p }} />)}
                </div>
                <table className="data legend">
                  <thead>
                    <tr><th>Cause</th><th className="num">Likely share</th><th className="num">8 in 10 between</th><th className="num">Amount</th></tr>
                  </thead>
                  <tbody>
                    {CAUSES.map((c, i) => {
                      const s = loss.split[c.key];
                      return (
                        <tr key={c.key}>
                          <td><i className={`swatch s${i}`} aria-hidden="true" /> {c.label}</td>
                          <td className="num"><b>{pct(s.p)}</b></td>
                          <td className="num muted">{pct(s.p10)} – {pct(s.p90)}</td>
                          <td className="num">{fmtQty(s.kg)} <small>{g.unit}</small></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <ul className="reasons">
                  {loss.reasons.length ? loss.reasons.map((r) => <li key={r}>{cap(r)}</li>) : <li>Nothing unusual today, so the usual split applies.</li>}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

function Slider(p: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="slider">
      <span>{p.label}</span>
      <input type="range" min={p.min} max={p.max} value={p.value} onChange={(e) => p.onChange(+e.target.value)} />
      <b className="num">{p.value} <small>{p.unit}</small></b>
    </label>
  );
}
