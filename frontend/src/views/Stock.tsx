import { useEffect, useMemo, useState } from "react";
import { api, LedgerEvent, LossSplit, Recipe } from "../api";
import type { Data } from "../App";
import { BurnTable, burnFromLedger, cap, fmtQty, pct } from "../derive";
import { Empty, ErrorLine, Panel, Segmented, Skeleton, ViewHead } from "../ui";

const MIN_DAYS = 3;

/** Recipe inference over the ledger's own burn table; shared by Today's chain and this view. */
export function useWastage(events: LedgerEvent[]) {
  const table = useMemo(() => burnFromLedger(events), [events]);
  const key = JSON.stringify([table.plates, table.burn]);
  const enough = table.days.length >= MIN_DAYS && table.dishes.length > 0 && table.ingredients.length > 0;
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enough) {
      setRecipe(null);
      return;
    }
    let alive = true;
    api
      .recipe(table.burn, table.plates)
      .then((r) => alive && (setRecipe(r), setError(null)))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // key captures the table's numbers; the table object changes on every poll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enough]);

  const wasted = table.ingredients.map((_, j) =>
    recipe ? Math.max(0, recipe.unexplained_per_day.reduce((s, d) => s + d[j], 0)) : 0,
  );
  const worst = wasted.reduce((b, w, j) => (w > (wasted[b] ?? -1) ? j : b), 0);
  const result =
    recipe && table.ingredients.length
      ? {
          headline: `${wasted[worst].toFixed(2)} ${table.ingredients[worst].unit} ${table.ingredients[worst].name}`,
          sub: `over ${table.days.length} days of trading`,
        }
      : null;
  const status = enough ? (error ? "could not compute" : "working…") : `${table.days.length} of ${MIN_DAYS} days`;
  return { table, recipe, wasted, worst, result, status, error, enough };
}

export default function Stock(d: Data) {
  const w = useWastage(d.events);
  const { table, recipe } = w;
  const line = !w.enough
    ? `The worker needs at least ${MIN_DAYS} days with both sales in plates and stock bought in kg or litres. It has ${table.days.length} so far.`
    : w.result
      ? `${cap(w.result.headline)} went somewhere other than a plate ${w.result.sub}.`
      : "Working out the recipe from the ledger…";
  return (
    <>
      <ViewHead title="Stock and waste" line={line} />
      <div className="grid">
        <BurnPanel table={table} />
        <RecipePanel w={w} />
        <LossPanel w={w} />
      </div>
    </>
  );
}

function BurnPanel({ table }: { table: BurnTable }) {
  const empty = table.days.length === 0;
  return (
    <Panel
      title="Daily burn from the ledger"
      note="Plates sold and stock bought per day. Without a stock count, what was bought stands in for what was used."
      className="span-7"
    >
      {empty ? (
        <Empty>No sales in plates or stock bought in kg or litres yet. Record trades like “3 kilo poha liya 150” and “7 plate poha de”.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Day</th>
                {table.dishes.map((x) => <th key={x} className="num">{x} plates</th>)}
                {table.ingredients.map((g) => <th key={g.name} className="num">{g.name} bought</th>)}
              </tr>
            </thead>
            <tbody>
              {table.days.map((day, i) => (
                <tr key={day}>
                  <td className="num-left">{new Date(day).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</td>
                  {table.plates[i].map((v, j) => <td key={j} className="num">{v ? fmtQty(v) : <span className="dash">—</span>}</td>)}
                  {table.burn[i].map((v, j) => (
                    <td key={j} className="num">
                      {v ? <>{fmtQty(v)} <small>{table.ingredients[j].unit}</small></> : <span className="dash">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {table.skipped > 0 && (
        <p className="panel-foot">
          {table.skipped} {table.skipped === 1 ? "trade was" : "trades were"} left out because the phone that booked {table.skipped === 1 ? "it" : "them"} had a
          broken clock, so the day is unknown.
        </p>
      )}
    </Panel>
  );
}

function RecipePanel({ w }: { w: ReturnType<typeof useWastage> }) {
  const { table, recipe } = w;
  return (
    <Panel title="Recipe the worker learned" note="No recipe card needed: worked out from what sold and what was used." className="span-5">
      {!w.enough ? (
        <Empty>Appears after {MIN_DAYS} days of trading. {table.days.length} so far.</Empty>
      ) : w.error ? (
        <ErrorLine error={`Couldn't work out the recipe. ${w.error}`} />
      ) : !recipe ? (
        <div className="stack-8"><Skeleton /><Skeleton w="70%" /></div>
      ) : (
        <>
          <ul className="rows">
            {table.dishes.map((dish, i) => (
              <li key={dish} className="kv">
                <span>1 plate of <b>{dish}</b></span>
                <span className="num">
                  {table.ingredients
                    .map((g, j) => ({ g, v: recipe.usage_per_plate[i][j] }))
                    .filter(({ v }) => v > 0.0005)
                    .map(({ g, v }) => `${Math.round(v * 1000)} ${g.unit === "kg" ? "g" : "ml"} ${g.name}`)
                    .join(" + ") || "nothing measurable"}
                </span>
              </li>
            ))}
          </ul>
          <p className="panel-foot">
            Steady waste a day:{" "}
            {table.ingredients.map((g, j) => `${recipe.baseline_waste_per_day[j].toFixed(2)} ${g.unit} ${g.name}`).join(" · ")}
          </p>
        </>
      )}
    </Panel>
  );
}

const CAUSES = [
  { key: "spoilage", label: "Spoiled" },
  { key: "theft", label: "Taken" },
  { key: "personal", label: "Eaten by family" },
] as const;

function LossPanel({ w }: { w: ReturnType<typeof useWastage> }) {
  const { table } = w;
  const [ing, setIng] = useState(0);
  const [temp, setTemp] = useState(32);
  const [away, setAway] = useState(0);
  const [family, setFamily] = useState(0);
  const [perishable, setPerishable] = useState<string[]>([]);
  const [loss, setLoss] = useState<LossSplit | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.lexicon().then((l) => Array.isArray(l.perishable) && setPerishable(l.perishable)).catch(() => {});
  }, []);
  useEffect(() => setIng(w.worst), [w.worst]);

  const g = table.ingredients[ing];
  const kg = w.wasted[ing] ?? 0;
  const spoils = g ? perishable.includes(g.name) : false;

  useEffect(() => {
    if (!w.recipe || !g) return;
    const t = setTimeout(() => {
      api
        .loss(kg, { temperature_c: temp, unattended_hours: away, family_present: family, perishable: spoils })
        .then((r) => (setLoss(r), setError(null)))
        .catch((e) => setError(String(e)));
    }, 150);
    return () => clearTimeout(t);
  }, [w.recipe, g, kg, temp, away, family, spoils]);

  return (
    <Panel
      title="Where the waste went"
      note="A spread of likely causes, not a verdict. Tell the worker about today and the split moves."
      className="span-12"
    >
      {!w.enough || !g ? (
        <Empty>Appears once the recipe is known.</Empty>
      ) : (
        <div className="loss">
          <div className="loss-controls">
            {table.ingredients.length > 1 && (
              <Segmented
                label="Ingredient"
                value={String(ing)}
                options={table.ingredients.map((x, j) => ({ value: String(j), label: x.name }))}
                onChange={(v) => setIng(Number(v))}
              />
            )}
            <p className="loss-total">
              <b className="money lg">{kg.toFixed(2)} {g.unit}</b> of {g.name} unexplained{spoils ? ", and it spoils fast" : ""}
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
                  {CAUSES.map((c, i) => (
                    <i key={c.key} className={`seg s${i}`} style={{ flexGrow: loss.split[c.key].p }} />
                  ))}
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
                          <td className="num">{s.kg.toFixed(2)} <small>{g.unit}</small></td>
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
