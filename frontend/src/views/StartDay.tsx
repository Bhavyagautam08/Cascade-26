import { useEffect, useRef, useState } from "react";
import { api, inr, InvDraft, InvItem, InvStatus, LedgerEvent } from "../api";
import type { Data } from "../App";
import { pct, what } from "../derive";
import { Icon } from "../icons";
import { Empty, ErrorLine, KindTag, Panel, useAction, ViewHead } from "../ui";

// Morning inventory: say what stock you have and what it cost; check the table; save.
// The backend never guesses: anything missing or ambiguous comes back as a question on the row,
// and saving is refused until every question is answered here.

const STATUS: { value: InvStatus; label: string }[] = [
  { value: "opening", label: "Already had it" },
  { value: "purchased", label: "Bought today" },
  { value: "unclear", label: "? Choose" },
];
const UNITS = ["kg", "l", "piece", "dozen", "packet", "bottle", "plate"];

type Rec = { state: "idle" } | { state: "recording"; started: number } | { state: "reading" };

function micError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError") return "The browser was not allowed to use the microphone. Allow it in the address bar (the mic icon), then try again - or type the items below.";
  if (name === "NotFoundError") return "No microphone found. Plug one in, or type the items below.";
  if (name === "NotReadableError") return "The microphone is busy or muted in Windows. Check Settings > System > Sound > Input, or type the items below.";
  return `The microphone could not start (${name ?? String(e)}). Type the items below instead.`;
}

/** Same rule as the backend: what still needs an answer before saving. */
function questionFor(i: InvItem): string | null {
  const q: string[] = [];
  if (i.qty == null) q.push(`How much ${i.item} is there?`);
  else if (!i.unit) q.push(`${i.qty} of ${i.item} - kilo, litre, or pieces?`);
  if (i.status === "unclear") q.push(`Did you buy the ${i.item} this morning, or was it already with you?`);
  return q.join(" ") || null;
}

export default function StartDay(d: Data) {
  const [rec, setRec] = useState<Rec>({ state: "idle" });
  const [seconds, setSeconds] = useState(0);
  const [draft, setDraft] = useState<InvDraft | null>(null);
  const [items, setItems] = useState<InvItem[]>([]);
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState("");
  const [isTyped, setIsTyped] = useState(false);
  const [overwrite, setOverwrite] = useState<{ item: string; qty: number; unit: string }[] | null>(null);
  const [saved, setSaved] = useState<{ duplicate: boolean; count: number } | null>(null);
  const [today, setToday] = useState<LedgerEvent[] | null>(null);
  const { busy, error, run, setError } = useAction();
  const media = useRef<{ rec: MediaRecorder; stream: MediaStream; chunks: Blob[]; cancelled: boolean } | null>(null);

  const loadToday = () => api.inventoryToday().then((r) => setToday(r.events)).catch(() => setToday([]));
  useEffect(() => {
    loadToday();
  }, []);
  useEffect(() => {
    if (rec.state !== "recording") return;
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - rec.started) / 1000)), 250);
    return () => clearInterval(t);
  }, [rec]);

  function show(dr: InvDraft, fromTyping: boolean) {
    setDraft(dr);
    setItems(dr.items);
    setIsTyped(fromTyping);
    setEditing(dr.items.some((i) => i.question));
    setOverwrite(null);
    setSaved(null);
  }

  async function startRecording() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser cannot record audio. Type the items below instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const r = new MediaRecorder(stream);
      const m = { rec: r, stream, chunks: [] as Blob[], cancelled: false };
      r.ondataavailable = (e) => e.data.size && m.chunks.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (m.cancelled) return setRec({ state: "idle" });
        const blob = new Blob(m.chunks, { type: r.mimeType || "audio/webm" });
        setRec({ state: "reading" });
        const dr = await run(() => api.inventoryVoice(blob));
        setRec({ state: "idle" });
        if (dr) show(dr, false);
      };
      media.current = m;
      r.start();
      setSeconds(0);
      setRec({ state: "recording", started: Date.now() });
    } catch (e) {
      setError(micError(e));
    }
  }
  const stopRecording = () => media.current?.rec.state === "recording" && media.current.rec.stop();
  const cancelRecording = () => {
    if (media.current) media.current.cancelled = true;
    stopRecording();
  };

  async function readTyped() {
    const dr = await run(() => api.inventoryText(typed));
    if (dr) show(dr, true);
  }

  function edit(i: number, field: keyof InvItem, value: string) {
    setItems((xs) =>
      xs.map((x, j) => {
        if (j !== i) return x;
        const v = field === "item" || field === "unit" || field === "status" ? value : value === "" ? null : Number(value);
        const next = { ...x, [field]: v } as InvItem;
        next.unit_cost = next.total_cost != null && next.qty ? Math.round((next.total_cost / next.qty) * 100) / 100 : null;
        next.question = questionFor(next);
        return next;
      }),
    );
  }
  const remove = (i: number) => setItems((xs) => xs.filter((_, j) => j !== i));

  async function save(replace: boolean) {
    if (!draft) return;
    const r = await run(() => api.inventoryConfirm(draft.recording_id, draft.transcript, items, replace, isTyped));
    if (!r) return;
    if (r.status === 409) return setOverwrite(r.data.existing);
    if (r.status === 422) {
      setItems((xs) => xs.map((x) => r.data.items.find((y) => y.item === x.item) ?? x));
      setEditing(true);
      return setError("Answer the marked questions first.");
    }
    setSaved({ duplicate: r.data.duplicate, count: r.data.events.length });
    setDraft(null);
    setOverwrite(null);
    loadToday();
    d.refresh();
  }

  const open = items.filter((i) => i.question).length;
  const total = items.reduce((s, i) => s + (i.total_cost ?? 0), 0);
  return (
    <>
      <ViewHead title="Start your day" line="Say what stock you have and what you paid. Check the list, then save it." />
      <div className="grid">
        <Panel title="Record your inventory" className="span-5" note="Speak naturally, in Hindi or Hinglish. Example: “Mere paas 5 kilo tamatar hain, 200 rupaye ke the. Do kilo aloo aaj liya 80 mein.”">
          <div className="form" style={{ alignItems: "center", textAlign: "center" }}>
            {rec.state === "recording" ? (
              <>
                <p className="result-head"><span className="status on"><span className="dot" aria-hidden="true" /> Recording · {seconds}s</span></p>
                <div className="form-row" style={{ justifyContent: "center" }}>
                  <button className="btn primary" onClick={stopRecording}>Stop and read</button>
                  <button className="btn" onClick={cancelRecording}>Cancel</button>
                </div>
              </>
            ) : (
              <button className="btn primary" style={{ fontSize: "1.15rem", padding: "1.1rem 2rem", borderRadius: 999 }}
                      disabled={busy || rec.state === "reading"} onClick={startRecording}>
                <Icon.record /> {rec.state === "reading" ? "Listening to it…" : "Record your inventory"}
              </button>
            )}
            <ErrorLine error={error} />
          </div>
          <details style={{ marginTop: "var(--gap)" }}>
            <summary className="hint">No mic, or too loud? Type it instead</summary>
            <div className="form">
              <textarea className="input" rows={3} value={typed} onChange={(e) => setTyped(e.target.value)}
                        placeholder="5 kilo tamatar hain 200 ke, do kilo aloo aaj liya 80 mein" />
              <button className="btn" disabled={busy || !typed.trim()} onClick={readTyped}>Read it</button>
            </div>
          </details>
        </Panel>

        <Panel title="Today's saved stock" className="span-7" note="What you confirmed this morning. Saving again never replaces it without asking.">
          {today == null ? null : today.length === 0 ? (
            <Empty>Nothing saved yet today.</Empty>
          ) : (
            <ul className="rows">
              {today.map((e) => (
                <li key={e.id}>
                  <span className="booked-line"><KindTag kind={e.kind} /><span>{what(e)}</span></span>
                  <span className="row-end">{e.payload.amount_rupees != null ? <b className="money">{inr(e.payload.amount_rupees)}</b> : <span className="muted">no price</span>}</span>
                </li>
              ))}
            </ul>
          )}
          {saved && (
            <div className="result">
              <Icon.check /> {saved.duplicate ? "That recording was already saved - nothing was added twice." : `Saved ${saved.count} ${saved.count === 1 ? "item" : "items"}.`}
            </div>
          )}
        </Panel>

        {draft && (
          <Panel
            title="Check your stock"
            className="span-12"
            note={<>Heard: “{draft.transcript}”{draft.heard_confidence != null && <> · {pct(draft.heard_confidence)} clear</>}{draft.already_saved && <b className="warn"> · This recording was saved before.</b>}</>}
            aside={<button className="btn" onClick={() => setEditing((x) => !x)}>{editing ? "Done editing" : "Edit"}</button>}
          >
            {items.length === 0 ? (
              <Empty>No stock was found in what was said. Record again, or type it.</Empty>
            ) : (
              <div className="table-scroll">
                <table className={`data ${editing ? "editable" : ""}`}>
                  <thead>
                    <tr><th>Item</th><th className="num">Qty</th><th>Unit</th><th className="num">Paid ₹</th><th className="num">₹ per unit</th><th>Already had / bought today</th>{editing && <th />}</tr>
                  </thead>
                  <tbody>
                    {items.map((it, i) => (
                      <tr key={i} className={it.question ? "doubt" : ""}>
                        {editing ? (
                          <>
                            <td><input className="input" aria-label="Item" value={it.item} onChange={(e) => edit(i, "item", e.target.value)} /></td>
                            <td><input className="input num" aria-label="Quantity" type="number" value={it.qty ?? ""} onChange={(e) => edit(i, "qty", e.target.value)} /></td>
                            <td>
                              <select className="input" aria-label="Unit" value={it.unit ?? ""} onChange={(e) => edit(i, "unit", e.target.value)}>
                                <option value="">?</option>
                                {[...new Set([...(it.unit ? [it.unit] : []), ...UNITS])].map((u) => <option key={u}>{u}</option>)}
                              </select>
                            </td>
                            <td><input className="input num" aria-label="Paid in rupees" type="number" placeholder="not said" value={it.total_cost ?? ""} onChange={(e) => edit(i, "total_cost", e.target.value)} /></td>
                          </>
                        ) : (
                          <>
                            <td>{it.item}{it.said && <small className="muted" style={{ display: "block" }}>“{it.said}”</small>}</td>
                            <td className="num">{it.qty ?? "?"}</td>
                            <td>{it.unit ?? "?"}</td>
                            <td className="num">{it.total_cost != null ? inr(it.total_cost) : <span className="muted">not said</span>}</td>
                          </>
                        )}
                        <td className="num">{it.unit_cost != null ? `${inr(it.unit_cost)}/${it.unit}` : "—"}</td>
                        <td>
                          <select className="input" aria-label="Already had or bought today" value={it.status} onChange={(e) => edit(i, "status", e.target.value)}>
                            {STATUS.map((s) => <option key={s.value} value={s.value} disabled={s.value === "unclear"}>{s.label}</option>)}
                          </select>
                          {it.question && <small className="warn" style={{ display: "block" }}>{it.question}</small>}
                        </td>
                        {editing && <td><button className="btn" onClick={() => remove(i)} aria-label={`Remove ${it.item}`}>Remove</button></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {overwrite && (
              <div className="result">
                <p className="warn">Already saved today: {overwrite.map((o) => `${o.item} ${o.qty ?? ""} ${o.unit ?? ""}`.trim()).join(", ")}.</p>
                <div className="form-row">
                  <button className="btn primary" disabled={busy} onClick={() => save(true)}>Replace them with this list</button>
                  <button className="btn" onClick={() => setOverwrite(null)}>Keep what I saved</button>
                </div>
              </div>
            )}
            <div className="form-row end">
              <p className="hint">
                {items.length} items · paid <b className="money">{inr(total)}</b>
                {open > 0 && <span className="warn"> · {open} {open === 1 ? "question" : "questions"} to answer</span>}
              </p>
              <button className="btn" onClick={() => setDraft(null)}>Discard</button>
              <button className="btn primary" disabled={busy || open > 0 || items.length === 0} onClick={() => save(false)}>
                Confirm and save
              </button>
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}
