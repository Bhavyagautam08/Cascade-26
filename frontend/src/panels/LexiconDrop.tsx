import { useEffect, useState } from "react";
import { api, Lexicon } from "../api";
import { Card, ErrorLine, useAction } from "../ui";

const SECTIONS: Record<string, { key: string; value: string; help: string }> = {
  units: { key: "peti", value: "20", help: "word → kg/l/plate factor" },
  items: { key: "shimla", value: "capsicum", help: "local word → item" },
  aliases: { key: "gupta ji", value: "gupta", help: "nickname → customer" },
  verbs: { key: "uthaya", value: "purchase", help: "word → purchase / sale / credit_given / credit_paid / expense" },
  numbers: { key: "dhai", value: "2.5", help: "number word → value" },
  prices: { key: "vada pav", value: "15", help: "item → ₹ per plate" },
  perishable: { key: "capsicum", value: "", help: "item that spoils fast" },
};
const UNIT_KINDS = ["kg", "l", "plate", "packet"];

export default function LexiconDrop({ onChange }: { onChange: () => void }) {
  const [lex, setLex] = useState<Lexicon | null>(null);
  const [section, setSection] = useState("units");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("kg");
  const [fresh, setFresh] = useState<string | null>(null);
  const { busy, error, run, setError } = useAction();

  useEffect(() => {
    api.lexicon().then(setLex).catch((e) => setError(String(e)));
  }, [setError]);

  async function add() {
    const k = key.trim().toLowerCase();
    if (!k) return;
    let v: unknown = value.trim();
    if (section === "units") v = { unit, factor: Number(value) || 1 };
    else if (section === "numbers" || section === "prices") v = Number(value);
    else if (section === "perishable") v = null;
    const out = await run(() => api.addLexicon(section, k, v));
    if (out) {
      setLex(out);
      setFresh(`${section}:${k}`);
      setKey("");
      setValue("");
      onChange();
    }
  }

  const s = SECTIONS[section];
  return (
    <Card title="Lexicon Drop" hint="new words take effect on the next sentence — no retraining">
      <div className="stack">
        <div className="row">
          <select className="input" value={section} onChange={(e) => setSection(e.target.value)}>
            {Object.keys(SECTIONS).map((x) => <option key={x}>{x}</option>)}
          </select>
          <input className="input grow" placeholder={s.key} value={key} onChange={(e) => setKey(e.target.value)} />
          {section !== "perishable" && (
            <input
              className="input"
              style={{ width: 120 }}
              placeholder={s.value}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
          )}
          {section === "units" && (
            <select className="input" value={unit} onChange={(e) => setUnit(e.target.value)}>
              {UNIT_KINDS.map((u) => <option key={u}>{u}</option>)}
            </select>
          )}
          <button className="btn primary" disabled={busy} onClick={add}>Drop</button>
        </div>
        <div className="small muted">{s.help}</div>
        <ErrorLine error={error} />
        {lex && (
          <div className="lex-sections">
            {Object.entries(lex).map(([sec, entries]) => (
              <div key={sec}>
                <div className="small muted" style={{ marginBottom: 3 }}>{sec}</div>
                <div className="tags">
                  {(Array.isArray(entries) ? entries : Object.keys(entries)).map((k) => (
                    <span key={k} className={`tag ${fresh === `${sec}:${k}` ? "fresh" : ""}`} title={Array.isArray(entries) ? k : JSON.stringify(entries[k])}>
                      {k}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
