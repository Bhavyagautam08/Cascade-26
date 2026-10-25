import { useEffect, useState } from "react";
import { api, Health, IngestResult, inr, Slip, SlipLine, Transcript } from "../api";
import { Card, Conf, ErrorLine, KindBadge, confColor, useAction } from "../ui";

const EXAMPLES = [
  "Bhai 3 kilo tamatar liya 180 mein… Sharma ji ka 40 jama kar, aur 7 plate poha de.",
  "aaj bahut garmi hai bhai",
  "pandey ji ka 60 udhaar likh",
  "5 cup chai de",
  "2 peti kanda liya 300",
];

type Tab = "text" | "voice" | "slip" | "clip";

export default function Capture({ health, onChange }: { health: Health | null; onChange: () => void }) {
  const [tab, setTab] = useState<Tab>("text");
  const demo = health?.model_mode === "demo";
  return (
    <Card
      title="Capture"
      hint="every channel ends up as balanced ledger events"
      right={
        <div className="tabs" role="tablist">
          {(["text", "voice", "slip", "clip"] as Tab[]).map((t) => (
            <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {{ text: "Type / SMS", voice: "Voice", slip: "Slip photo", clip: "Audio clip" }[t]}
            </button>
          ))}
        </div>
      }
    >
      {tab === "text" && <TextTab onChange={onChange} />}
      {tab === "voice" && <VoiceTab health={health} onChange={onChange} />}
      {tab === "slip" && <SlipTab demo={demo} onChange={onChange} />}
      {tab === "clip" && <ClipTab demo={demo} onChange={onChange} />}
    </Card>
  );
}

function Created({ result }: { result: IngestResult }) {
  if (!result.events.length)
    return (
      <div className="result">
        <b>No transaction</b> <span className="muted">— treated as chatter (engine: {result.engine})</span>
      </div>
    );
  return (
    <div className="result stack" style={{ gap: 6 }}>
      <div className="small muted">
        {result.events.length} event{result.events.length > 1 ? "s" : ""} via <b>{result.engine}</b>
      </div>
      {result.events.map((e) => (
        <div key={e.id} className="row small">
          <KindBadge kind={e.kind} />
          <span>
            {[e.payload.qty != null && `${e.payload.qty} ${e.payload.unit ?? ""}`, e.payload.item, e.payload.party]
              .filter(Boolean)
              .join(" · ") || "—"}
          </span>
          <b style={{ marginLeft: "auto" }}>{e.payload.amount_rupees != null ? inr(e.payload.amount_rupees) : "amount ?"}</b>
          <Conf value={e.confidence} />
        </div>
      ))}
    </div>
  );
}

function TextTab({ onChange }: { onChange: () => void }) {
  const [text, setText] = useState("");
  const [source, setSource] = useState("manual");
  const [engine, setEngine] = useState("auto");
  const [result, setResult] = useState<IngestResult | null>(null);
  const { busy, error, run } = useAction();

  async function submit() {
    if (!text.trim()) return;
    const r = await run(() => api.ingestText(text, source, engine));
    if (r) {
      setResult(r);
      setText("");
      onChange();
    }
  }

  return (
    <div className="stack">
      <textarea
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && submit()}
        placeholder="Type what was said, paste an SMS, or a tally line…  (Ctrl+Enter)"
      />
      <div className="row">
        <label className="field">
          Source
          <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="manual">typed</option>
            <option value="sms">SMS</option>
            <option value="tally">tally sheet</option>
            <option value="voice">voice (transcript)</option>
          </select>
        </label>
        <label className="field">
          Engine
          <select className="input" value={engine} onChange={(e) => setEngine(e.target.value)}>
            <option value="auto">auto (LLM → rules)</option>
            <option value="llm">LLM only</option>
            <option value="rules">rules only</option>
          </select>
        </label>
        <button className="btn primary" style={{ marginLeft: "auto", alignSelf: "end" }} disabled={busy} onClick={submit}>
          {busy ? "Reading…" : "Add to ledger"}
        </button>
      </div>
      <div className="row">
        {EXAMPLES.map((x) => (
          <button key={x} className="example" onClick={() => setText(x)}>
            {x.length > 46 ? x.slice(0, 44) + "…" : x}
          </button>
        ))}
      </div>
      <ErrorLine error={error} />
      {result && <Created result={result} />}
    </div>
  );
}

function VoiceTab({ health, onChange }: { health: Health | null; onChange: () => void }) {
  const [feed, setFeed] = useState<Transcript[]>([]);
  const [text, setText] = useState("");
  const [conf, setConf] = useState(0.9);
  const { busy, error, run } = useAction();

  useEffect(() => {
    let alive = true;
    const tick = () => api.recentTranscripts().then((f) => alive && setFeed(f)).catch(() => {});
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  async function simulate() {
    if (!text.trim()) return;
    if (await run(() => api.simulateHeard(text, conf))) {
      setText("");
      onChange();
      setFeed(await api.recentTranscripts());
    }
  }

  return (
    <div className="stack">
      <div className="row small">
        {health?.mic_listening ? (
          <span className="chip good">mic listening</span>
        ) : (
          <span className="chip warn">mic off — set MIC_ENABLED=true in backend\.env</span>
        )}
        <span className="muted">raw audio is never stored, only the transcript</span>
      </div>
      <div className="feed">
        {feed.length === 0 && <div className="empty">Nothing heard yet.</div>}
        {[...feed].reverse().map((u, i) => (
          <div className="utt" key={i}>
            <div>{u.text}</div>
            <div className="meta">
              <span style={{ color: confColor(u.confidence) }}>heard {Math.round(u.confidence * 100)}%</span>
              <span>via {u.via}</span>
              <span>lang {u.language}</span>
              <span>{u.events ? `${u.events} event${u.events > 1 ? "s" : ""} (${u.engine})` : "chatter — ignored"}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="row">
        <input
          className="input grow"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && simulate()}
          placeholder="Simulate what the mic heard (backup when the hall is loud)"
        />
        <label className="small muted row" title="how sure the ASR was">
          heard
          <input type="range" min={0.3} max={1} step={0.05} value={conf} onChange={(e) => setConf(+e.target.value)} />
          {Math.round(conf * 100)}%
        </label>
        <button className="btn" disabled={busy} onClick={simulate}>
          Inject
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

function SlipTab({ demo, onChange }: { demo: boolean; onChange: () => void }) {
  const [slip, setSlip] = useState<Slip | null>(null);
  const [lines, setLines] = useState<SlipLine[]>([]);
  const [supplier, setSupplier] = useState("");
  const [posted, setPosted] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  async function read(file: File) {
    setPosted(null);
    setPreview(URL.createObjectURL(file));
    const s = await run(() => api.readSlip(file));
    if (s) {
      setSlip(s);
      setLines(s.lines);
      setSupplier(s.supplier ?? "");
    }
  }

  function edit(i: number, field: keyof SlipLine, value: string) {
    setLines((ls) =>
      ls.map((l, j) =>
        j !== i ? l : { ...l, [field]: field === "item" || field === "unit" ? value : value === "" ? null : Number(value) },
      ),
    );
  }

  async function confirm() {
    // Vendor has checked every line, so confirmed lines carry full confidence.
    const ok = lines.filter((l) => l.item && l.amount_rupees != null).map((l) => ({ ...l, confidence: 1 }));
    const r = await run(() => api.confirmSlip(supplier || null, ok));
    if (r) {
      setPosted(r.events.length);
      setSlip(null);
      onChange();
    }
  }

  const sum = lines.reduce((s, l) => s + (l.amount_rupees ?? 0), 0);
  return (
    <div className="stack">
      <label className="drop">
        <input type="file" accept="image/*" capture="environment" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
        <b>{busy ? "Reading slip…" : "Photo of a wholesale slip"}</b>
        <span className="small muted">stained, crumpled, Hindi or English — doubtful lines are flagged for you</span>
      </label>
      {demo && <div className="small muted">Demo mode: the reader returns one sample slip whatever the photo.</div>}
      <ErrorLine error={error} />
      {posted != null && <div className="result">Posted {posted} purchase{posted === 1 ? "" : "s"} to the ledger.</div>}
      {slip && (
        <>
          <div className="row">
            {preview && <img src={preview} alt="slip" style={{ height: 64, borderRadius: 8, border: "1px solid var(--line)" }} />}
            <label className="field grow">
              Supplier
              <input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </label>
            <span className="small muted">read by {slip.reader}</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th>Unit</th>
                  <th className="num">Amount ₹</th>
                  <th>Read</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className={l.confidence < 0.6 ? "low" : ""}>
                    <td><input className="input" value={l.item} onChange={(e) => edit(i, "item", e.target.value)} /></td>
                    <td><input className="input" type="number" value={l.qty ?? ""} onChange={(e) => edit(i, "qty", e.target.value)} /></td>
                    <td><input className="input" value={l.unit ?? ""} onChange={(e) => edit(i, "unit", e.target.value)} /></td>
                    <td>
                      <input
                        className="input"
                        type="number"
                        placeholder="unreadable"
                        value={l.amount_rupees ?? ""}
                        onChange={(e) => edit(i, "amount_rupees", e.target.value)}
                      />
                    </td>
                    <td><Conf value={l.confidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row small">
            <span className="muted">
              Lines total {inr(sum)}
              {slip.total_rupees != null && <> · slip says {inr(slip.total_rupees)}</>}
              {slip.total_rupees != null && Math.abs(slip.total_rupees - sum) > 0.5 && (
                <b style={{ color: "var(--warn)" }}> · gap {inr(slip.total_rupees - sum)} — check the highlighted lines</b>
              )}
            </span>
            <button className="btn primary" style={{ marginLeft: "auto" }} disabled={busy} onClick={confirm}>
              Confirm &amp; post
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ClipTab({ demo, onChange }: { demo: boolean; onChange: () => void }) {
  const [out, setOut] = useState<(IngestResult & { transcript: string | null; asr?: string }) | null>(null);
  const { busy, error, run } = useAction();
  async function upload(file: File) {
    const r = await run(() => api.ingestAudio(file));
    if (r) {
      setOut(r);
      onChange();
    }
  }
  return (
    <div className="stack">
      <label className="drop">
        <input type="file" accept="audio/*" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <b>{busy ? "Transcribing…" : "Upload a recorded clip"}</b>
        <span className="small muted">same speech-to-text and extractor as the live mic (pre-recorded backup demo)</span>
      </label>
      {demo && <div className="small muted">Demo mode: the transcript comes from the demo script, not the audio.</div>}
      <ErrorLine error={error} />
      {out && (
        <>
          <div className="utt">
            <div>{out.transcript ?? <span className="muted">no speech found</span>}</div>
            {out.asr && <div className="meta">ASR: {out.asr}</div>}
          </div>
          {out.transcript && <Created result={out} />}
        </>
      )}
    </div>
  );
}
