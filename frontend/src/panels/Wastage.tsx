import { useEffect, useState } from "react";
import { api, LossSplit, Recipe } from "../api";
import { Card, ErrorLine, useAction } from "../ui";

// Five days at the stall. Burn = stock consumed (opening + purchases − closing count).
const DISHES = ["poha plates", "chai cups"];
const INGREDIENTS = [
  { name: "poha", unit: "kg", per: "g", scale: 1000, perishable: false },
  { name: "milk", unit: "l", per: "ml", scale: 1000, perishable: true },
];
const SEED = [
  // poha plates, chai cups, poha kg burnt, milk l burnt
  [50, 60, 4.3, 6.6],
  [80, 45, 6.6, 4.9],
  [65, 70, 5.6, 7.8],
  [40, 55, 3.45, 6.0],
  [90, 80, 7.35, 8.3],
];

const CAUSES = [
  { key: "spoilage", label: "Spoilage", color: "var(--spoil)" },
  { key: "theft", label: "Theft", color: "var(--theft)" },
  { key: "personal", label: "Personal use", color: "var(--personal)" },
] as const;

export default function Wastage() {
  const [rows, setRows] = useState<number[][]>(SEED);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [ing, setIng] = useState(0);
  const [temp, setTemp] = useState(36);
  const [away, setAway] = useState(2);
  const [family, setFamily] = useState(1);
  const [loss, setLoss] = useState<LossSplit | null>(null);
  const { busy, error, run } = useAction();

  async function infer() {
    const r = await run(() => api.recipe(rows.map((r) => r.slice(2)), rows.map((r) => r.slice(0, 2))));
    if (r) setRecipe(r);
  }
  useEffect(() => {
    infer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wasted = recipe ? Math.max(0, recipe.unexplained_per_day.reduce((s, d) => s + d[ing], 0)) : 0;
  const perishable = INGREDIENTS[ing].perishable;

  useEffect(() => {
    if (!recipe) return;
    const t = setTimeout(() => {
      api
        .loss(wasted, { temperature_c: temp, unattended_hours: away, family_present: family, perishable })
        .then(setLoss)
        .catch(() => {});
    }, 150);
    return () => clearTimeout(t);
  }, [recipe, wasted, temp, away, family, perishable]);

  const edit = (i: number, j: number, v: string) =>
    setRows((rs) => rs.map((r, a) => (a !== i ? r : r.map((x, b) => (b === j ? Number(v) : x)))));

  return (
    <Card
      title="Raw material burn → inferred wastage → who took it"
      hint="zero-shot recipe (NNLS, no bill of materials) · loss split as a distribution"
      className="span-2"
    >
      <div className="grid" style={{ gap: 20 }}>
        <div className="stack">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  {DISHES.map((d) => <th key={d} className="num">{d}</th>)}
                  {INGREDIENTS.map((g) => <th key={g.name} className="num">{g.name} used ({g.unit})</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="muted">{i + 1}</td>
                    {r.map((v, j) => (
                      <td key={j}>
                        <input className="input" type="number" step="any" value={v} onChange={(e) => edit(i, j, e.target.value)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <button className="btn sm" onClick={() => setRows((rs) => [...rs, rs[rs.length - 1].slice()])}>+ day</button>
            {rows.length > 3 && <button className="btn sm ghost" onClick={() => setRows((rs) => rs.slice(0, -1))}>− day</button>}
            <button className="btn primary sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={infer}>Infer recipe</button>
          </div>
          <ErrorLine error={error} />
          {recipe && (
            <div className="result stack" style={{ gap: 6 }}>
              <b>Learned recipe</b>
              {DISHES.map((d, i) => (
                <div key={d} className="small">
                  1 {d.replace(/s$/, "")} uses{" "}
                  {INGREDIENTS.map((g, j) => `${Math.round(recipe.usage_per_plate[i][j] * g.scale)} ${g.per} ${g.name}`).join(" + ")}
                </div>
              ))}
              <div className="small muted">
                Burn the sales can't explain:{" "}
                {INGREDIENTS.map((g, j) => `${recipe.baseline_waste_per_day[j].toFixed(2)} ${g.unit}/day ${g.name}`).join(" · ")}
              </div>
            </div>
          )}
        </div>

        <div className="stack">
          <div className="row">
            <label className="field">
              Ingredient
              <select className="input" value={ing} onChange={(e) => setIng(+e.target.value)}>
                {INGREDIENTS.map((g, j) => <option key={g.name} value={j}>{g.name}{g.perishable ? " (perishable)" : ""}</option>)}
              </select>
            </label>
            <div className="grow small" style={{ alignSelf: "end" }}>
              <b>{wasted.toFixed(2)} {INGREDIENTS[ing].unit}</b> <span className="muted">unexplained over {rows.length} days</span>
            </div>
          </div>
          <Slider label="Heat" value={temp} min={20} max={45} unit="°C" onChange={setTemp} />
          <Slider label="Stall unattended" value={away} min={0} max={8} unit="h/day" onChange={setAway} />
          <Slider label="Family eating at stall" value={family} min={0} max={5} unit="people" onChange={setFamily} />

          {loss && (
            <>
              <div className="split-bar">
                {CAUSES.map((c) => (
                  <div key={c.key} style={{ width: `${loss.split[c.key].p * 100}%`, background: c.color }}>
                    {Math.round(loss.split[c.key].p * 100)}%
                  </div>
                ))}
              </div>
              {CAUSES.map((c) => {
                const s = loss.split[c.key];
                return (
                  <div key={c.key} className="whisker-row">
                    <span>{c.label}</span>
                    <div className="whisker" title={`80% interval ${Math.round(s.p10 * 100)}–${Math.round(s.p90 * 100)}%`}>
                      <div className="ci" style={{ left: `${s.p10 * 100}%`, width: `${(s.p90 - s.p10) * 100}%`, background: c.color }} />
                      <div className="pt" style={{ left: `${s.p * 100}%`, background: c.color }} />
                    </div>
                    <span className="small mono">
                      {s.kg.toFixed(2)} {INGREDIENTS[ing].unit} · {Math.round(s.p10 * 100)}–{Math.round(s.p90 * 100)}%
                    </span>
                  </div>
                );
              })}
              <ul className="reasons">
                {loss.reasons.length ? loss.reasons.map((r) => <li key={r}>{r}</li>) : <li>no signal — priors only (50 / 20 / 30)</li>}
              </ul>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function Slider(p: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="row small">
      <span style={{ width: 150 }} className="muted">{p.label}</span>
      <input className="grow" type="range" min={p.min} max={p.max} value={p.value} onChange={(e) => p.onChange(+e.target.value)} />
      <b style={{ width: 70, textAlign: "right" }}>
        {p.value} {p.unit}
      </b>
    </label>
  );
}
