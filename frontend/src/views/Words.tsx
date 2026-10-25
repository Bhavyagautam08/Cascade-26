import { useEffect, useState } from "react";
import { api, Lexicon } from "../api";
import type { Data } from "../App";
import { Empty, ErrorLine, Panel, Segmented, Skeleton, useAction, ViewHead } from "../ui";

type Section = "units" | "items" | "aliases" | "verbs" | "numbers" | "prices" | "perishable";
const SECTIONS: Record<Section, { label: string; key: string; keyHint: string; value: string; valueHint: string; help: string }> = {
  units: { label: "Units", key: "Word", keyHint: "peti", value: "Equals", valueHint: "20", help: "A local measure and what it equals." },
  items: { label: "Things", key: "Local word", keyHint: "shimla", value: "Means", valueHint: "capsicum", help: "Another name for something you buy or sell." },
  aliases: { label: "Customers", key: "Nickname", keyHint: "gupta ji", value: "Customer", valueHint: "gupta", help: "So “Gupta ji” and “Guptaji” land in one udhaar account." },
  verbs: { label: "Actions", key: "Word", keyHint: "uthaya", value: "Means", valueHint: "purchase", help: "Which kind of trade a word signals." },
  numbers: { label: "Numbers", key: "Word", keyHint: "dhai", value: "Value", valueHint: "2.5", help: "Number words as they are spoken." },
  prices: { label: "Prices", key: "Item", keyHint: "vada pav", value: "₹ a plate", valueHint: "15", help: "Used when a sale is heard without an amount." },
  perishable: { label: "Spoils fast", key: "Item", keyHint: "capsicum", value: "", valueHint: "", help: "Waste of these leans towards spoilage." },
};
const UNIT_KINDS = ["kg", "l", "plate", "packet"];
const KINDS = ["purchase", "sale", "credit_given", "credit_paid", "expense"];
const KIND_WORDS: Record<string, string> = { purchase: "bought", sale: "sold", credit_given: "udhaar given", credit_paid: "udhaar repaid", expense: "expense" };

function show(section: Section, v: unknown) {
  if (section === "units" && v && typeof v === "object") {
    const u = v as { unit: string; factor: number };
    return `${u.factor} ${u.unit}`;
  }
  if (section === "verbs") return KIND_WORDS[String(v)] ?? String(v);
  if (section === "prices") return `₹${v}`;
  return String(v);
}

export default function Words(_: Data) {
  const [lex, setLex] = useState<Lexicon | null>(null);
  const [section, setSection] = useState<Section>("units");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("kg");
  const [verb, setVerb] = useState("purchase");
  const [fresh, setFresh] = useState<string | null>(null);
  const { busy, error, run, setError } = useAction();

  // Poll too: a word can also be dropped by editing data/lexicon.json, which the backend reloads live.
  useEffect(() => {
    api.lexicon().then(setLex).catch((e) => setError(String(e)));
    const t = setInterval(() => api.lexicon().then(setLex).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [setError]);

  const s = SECTIONS[section];
  const needsNumber = section === "units" || section === "numbers" || section === "prices";

  async function add() {
    const k = key.trim().toLowerCase();
    if (!k) return;
    let v: unknown = value.trim();
    if (section === "units") v = { unit, factor: Number(value) || 1 };
    else if (section === "numbers" || section === "prices") v = Number(value);
    else if (section === "verbs") v = verb;
    else if (section === "perishable") v = null;
    const out = await run(() => api.addLexicon(section, k, v));
    if (out) {
      setLex(out);
      setFresh(`${section}:${k}`);
      setKey("");
      setValue("");
    }
  }

  const entries = lex?.[section];
  const list: [string, unknown][] = !entries ? [] : Array.isArray(entries) ? entries.map((k) => [k, null]) : Object.entries(entries);
  const total = lex ? Object.values(lex).reduce((n, e) => n + (Array.isArray(e) ? e.length : Object.keys(e).length), 0) : 0;

  return (
    <>
      <ViewHead
        title="Shop words"
        line={lex ? `The worker knows ${total} words. A new one works from the very next sentence, for listening and for reading. No retraining.` : "Loading the word list…"}
      />
      <Segmented label="Kind of word" value={section} options={(Object.keys(SECTIONS) as Section[]).map((k) => ({ value: k, label: SECTIONS[k].label }))} onChange={(v) => (setSection(v), setKey(""), setValue(""))} />
      <div className="grid" style={{ marginTop: "var(--gap)" }}>
        <Panel title={`Teach a new ${s.label.toLowerCase() === "spoils fast" ? "item that spoils" : s.label.toLowerCase().replace(/s$/, "")}`} note={s.help} className="span-5">
          <div className="form">
            <label className="field">
              <span>{s.key}</span>
              <input className="input" placeholder={s.keyHint} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
            </label>
            {section === "verbs" ? (
              <label className="field">
                <span>{s.value}</span>
                <select className="input" value={verb} onChange={(e) => setVerb(e.target.value)}>
                  {KINDS.map((k) => <option key={k} value={k}>{KIND_WORDS[k]}</option>)}
                </select>
              </label>
            ) : section !== "perishable" && (
              <div className="form-row">
                <label className="field grow">
                  <span>{s.value}</span>
                  <input
                    className={`input ${needsNumber ? "num" : ""}`}
                    inputMode={needsNumber ? "decimal" : undefined}
                    placeholder={s.valueHint}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && add()}
                  />
                </label>
                {section === "units" && (
                  <label className="field">
                    <span>Unit</span>
                    <select className="input" value={unit} onChange={(e) => setUnit(e.target.value)}>
                      {UNIT_KINDS.map((u) => <option key={u}>{u}</option>)}
                    </select>
                  </label>
                )}
              </div>
            )}
            <button className="btn primary" disabled={busy || !key.trim()} onClick={add}>
              {busy ? "Teaching…" : "Teach the worker"}
            </button>
            <ErrorLine error={error} />
          </div>
        </Panel>
        <Panel title={`${s.label} it knows`} className="span-7" aside={<span className="muted num">{list.length}</span>}>
          {!lex ? (
            <Skeleton />
          ) : list.length === 0 ? (
            <Empty>None yet.</Empty>
          ) : section === "perishable" ? (
            <div className="chips">
              {list.map(([k]) => <span key={k} className={`chip ${fresh === `${section}:${k}` ? "fresh" : ""}`}>{k}</span>)}
            </div>
          ) : (
            <div className="table-scroll tall">
              <table className="data">
                <thead><tr><th>{s.key}</th><th>{s.value}</th></tr></thead>
                <tbody>
                  {list.map(([k, v]) => (
                    <tr key={k} className={fresh === `${section}:${k}` ? "fresh" : ""}>
                      <td><b>{k}</b></td>
                      <td>{show(section, v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
