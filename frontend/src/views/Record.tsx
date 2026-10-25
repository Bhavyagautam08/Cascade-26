import { useEffect, useState } from "react";
import { api, inr, IngestResult, Slip, SlipLine, Transcript } from "../api";
import type { Data } from "../App";
import { amountText, pct, what } from "../derive";
import { Icon } from "../icons";
import { Conf, Empty, ErrorLine, KindTag, Panel, Segmented, useAction, ViewHead } from "../ui";

const EXAMPLES = [
  "Bhai 3 kilo tamatar liya 180 mein… Sharma ji ka 40 jama kar, aur 7 plate poha de.",
  "pandey ji ka 60 udhaar likh",
  "5 cup chai de",
  "2 peti kanda liya 300",
  "aaj bahut garmi hai bhai",
];

type Tab = "type" | "voice" | "slip" | "clip";
const TABS: { value: Tab; label: string }[] = [
  { value: "type", label: "Type or paste" },
  { value: "voice", label: "Heard by the mic" },
  { value: "slip", label: "Slip photo" },
  { value: "clip", label: "Voice recording" },
];

export default function Record(d: Data & { tab?: string }) {
  const tab: Tab = TABS.some((t) => t.value === d.tab) ? (d.tab as Tab) : "type";
  const demo = d.health?.model_mode === "demo";
  return (
    <>
      <ViewHead title="Record a trade" line="Every way in ends as balanced entries in the same books. Shop talk with no trade in it is ignored." />
      <Segmented label="How the trade comes in" value={tab} options={TABS} onChange={(t) => d.go("record", t)} />
      <div className="grid" style={{ marginTop: "var(--gap)" }}>
        {tab === "type" && <TypeTab d={d} />}
        {tab === "voice" && <VoiceTab d={d} />}
        {tab === "slip" && <SlipTab d={d} demo={demo} />}
        {tab === "clip" && <ClipTab d={d} demo={demo} />}
      </div>
    </>
  );
}

function Booked({ result }: { result: IngestResult }) {
  if (!result.events.length)
    return (
      <div className="result">
        <b>No trade in that.</b> <span className="muted">Treated as small talk ({result.engine}).</span>
      </div>
    );
  return (
    <div className="result">
      <p className="result-head">
        Booked {result.events.length} {result.events.length === 1 ? "entry" : "entries"} <span className="muted">· read by {result.engine}</span>
      </p>
      <ul className="rows">
        {result.events.map((e) => (
          <li key={e.id}>
            <a className="row-link" href={`#/entries/${encodeURIComponent(e.id)}`}>
              <span className="booked-line"><KindTag kind={e.kind} /><span>{what(e)}</span></span>
              <span className="row-end"><b className="money">{amountText(e)}</b><Conf value={e.confidence} /></span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TypeTab({ d }: { d: Data }) {
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
      d.refresh();
    }
  }

  return (
    <>
      <Panel title="What happened" className="span-7" note="Write it the way it was said, in any mix of Hindi and English.">
        <div className="form">
          <label className="field">
            <span>Trade, SMS or tally line</span>
            <textarea
              className="input"
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && submit()}
              placeholder="3 kilo tamatar liya 180"
            />
          </label>
          <div className="form-row">
            <label className="field">
              <span>Where it came from</span>
              <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="manual">Typed by me</option>
                <option value="sms">An SMS</option>
                <option value="tally">The tally sheet</option>
                <option value="voice">Something heard</option>
              </select>
            </label>
            <label className="field">
              <span>Who reads it</span>
              <select className="input" value={engine} onChange={(e) => setEngine(e.target.value)}>
                <option value="auto">Language model, rules if it's off</option>
                <option value="llm">Language model only</option>
                <option value="rules">Word rules only</option>
              </select>
            </label>
            <button className="btn primary" disabled={busy || !text.trim()} onClick={submit}>
              {busy ? "Reading…" : "Book it"}
            </button>
          </div>
          <p className="hint">Ctrl + Enter books it. The same trade sent again by SMS is counted once, not twice.</p>
          <ErrorLine error={error} />
          {result && <Booked result={result} />}
        </div>
      </Panel>
      <Panel title="Try one" className="span-5" note="Real phrasing from the stall. The last one is small talk.">
        <ul className="rows">
          {EXAMPLES.map((x) => (
            <li key={x}>
              <button className="row-link" onClick={() => setText(x)}>
                <span className="row-main"><span>{x}</span></span>
                <Icon.chevron />
              </button>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

function VoiceTab({ d }: { d: Data }) {
  const [feed, setFeed] = useState<Transcript[] | null>(null);
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

  async function inject() {
    if (!text.trim()) return;
    if (await run(() => api.simulateHeard(text, conf))) {
      setText("");
      d.refresh();
      setFeed(await api.recentTranscripts());
    }
  }

  const on = d.health?.mic_listening;
  return (
    <>
      <Panel
        title="Heard so far"
        className="span-7"
        aside={<span className={`status ${on ? "on" : ""}`}><span className="dot" aria-hidden="true" />{on ? "Mic on" : "Mic off"}</span>}
        note={on ? "Only the words are kept. The audio is thrown away as soon as it's read." : "Turn the mic on with MIC_ENABLED=true in backend\\.env on the main phone."}
      >
        {feed == null ? null : feed.length === 0 ? (
          <Empty>Nothing heard yet.</Empty>
        ) : (
          <ul className="rows feed">
            {[...feed].reverse().map((u, i) => (
              <li key={i} className="heard">
                <span className="row-main">
                  <span>{u.text}</span>
                  <small>
                    {u.events ? `${u.events} ${u.events === 1 ? "entry" : "entries"} booked by ${u.engine}` : "Small talk, nothing booked"} · {pct(u.confidence)} clear · {u.via}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Say it for the mic" className="span-5" note="For a loud hall: type what the mic should have heard and how clearly.">
        <div className="form">
          <label className="field">
            <span>What was said</span>
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && inject()} placeholder="5 cup chai de" />
          </label>
          <label className="slider">
            <span>How clearly it was heard</span>
            <input type="range" min={0.3} max={1} step={0.05} value={conf} onChange={(e) => setConf(+e.target.value)} />
            <b className="num">{pct(conf)}</b>
          </label>
          <button className="btn primary" disabled={busy || !text.trim()} onClick={inject}>
            {busy ? "Booking…" : "Pass to the worker"}
          </button>
          <ErrorLine error={error} />
        </div>
      </Panel>
    </>
  );
}

function SlipTab({ d, demo }: { d: Data; demo: boolean }) {
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
      ls.map((l, j) => (j !== i ? l : { ...l, [field]: field === "item" || field === "unit" ? value : value === "" ? null : Number(value) })),
    );
  }

  async function confirm() {
    // The vendor has checked every line, so confirmed lines carry full confidence.
    const ok = lines.filter((l) => l.item && l.amount_rupees != null).map((l) => ({ ...l, confidence: 1 }));
    const r = await run(() => api.confirmSlip(supplier || null, ok));
    if (r) {
      setPosted(r.events.length);
      setSlip(null);
      d.refresh();
    }
  }

  const sum = lines.reduce((s, l) => s + (l.amount_rupees ?? 0), 0);
  const gap = slip?.total_rupees != null ? slip.total_rupees - sum : 0;
  const doubtfulLines = lines.filter((l) => l.confidence < 0.6).length;
  return (
    <Panel
      title={slip ? "Check the slip" : "Photo of a wholesale slip"}
      className="span-12"
      note={slip ? `Read by ${slip.reader}. Lines the worker could not read well are marked. Nothing is booked until you confirm.` : "Stained, crumpled, Hindi or English. Nothing is booked until you check it."}
    >
      {!slip && (
        <label className="drop">
          <input type="file" accept="image/*" capture="environment" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
          <Icon.upload />
          <b>{busy ? "Reading the slip…" : "Take or choose a photo"}</b>
          {demo && <small>Practice mode returns one sample slip whatever the photo.</small>}
        </label>
      )}
      <ErrorLine error={error} />
      {posted != null && <div className="result"><Icon.check /> Booked {posted} {posted === 1 ? "purchase" : "purchases"} from the slip.</div>}
      {slip && (
        <div className="form">
          <div className="form-row">
            {preview && <img className="slip-thumb" src={preview} alt="The slip photo" />}
            <label className="field grow">
              <span>Supplier</span>
              <input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </label>
          </div>
          <div className="table-scroll">
            <table className="data editable">
              <thead>
                <tr><th>Item</th><th className="num">Qty</th><th>Unit</th><th className="num">Amount ₹</th><th className="num">Read</th></tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className={l.confidence < 0.6 ? "doubt" : ""}>
                    <td><input className="input" aria-label="Item" value={l.item} onChange={(e) => edit(i, "item", e.target.value)} /></td>
                    <td><input className="input num" aria-label="Quantity" type="number" value={l.qty ?? ""} onChange={(e) => edit(i, "qty", e.target.value)} /></td>
                    <td><input className="input" aria-label="Unit" value={l.unit ?? ""} onChange={(e) => edit(i, "unit", e.target.value)} /></td>
                    <td><input className="input num" aria-label="Amount in rupees" type="number" placeholder="unreadable" value={l.amount_rupees ?? ""} onChange={(e) => edit(i, "amount_rupees", e.target.value)} /></td>
                    <td className="num"><Conf value={l.confidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-row end">
            <p className="hint">
              Lines add up to <b className="money">{inr(sum)}</b>
              {slip.total_rupees != null && <> · slip total <b className="money">{inr(slip.total_rupees)}</b></>}
              {Math.abs(gap) > 0.5 && <span className="warn"> · {inr(Math.abs(gap))} {gap > 0 ? "missing" : "extra"}. Check the marked lines.</span>}
              {doubtfulLines > 0 && Math.abs(gap) <= 0.5 && <> · {doubtfulLines} hard to read</>}
            </p>
            <button className="btn" onClick={() => setSlip(null)}>Discard</button>
            <button className="btn primary" disabled={busy} onClick={confirm}>Confirm and book</button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function ClipTab({ d, demo }: { d: Data; demo: boolean }) {
  const [out, setOut] = useState<(IngestResult & { transcript: string | null; asr?: string }) | null>(null);
  const { busy, error, run } = useAction();
  async function upload(file: File) {
    const r = await run(() => api.ingestAudio(file));
    if (r) {
      setOut(r);
      d.refresh();
    }
  }
  return (
    <Panel title="A recorded clip" className="span-12" note="Goes through the same listening and reading as the live mic. Useful when the hall is too loud.">
      <label className="drop">
        <input type="file" accept="audio/*" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <Icon.upload />
        <b>{busy ? "Listening to the clip…" : "Choose a recording"}</b>
        {demo && <small>Practice mode reads a scripted line, not the audio.</small>}
      </label>
      <ErrorLine error={error} />
      {out && (
        <div className="result">
          <p className="result-head">{out.transcript ? <>“{out.transcript}”</> : "No speech found in the clip."}</p>
          {out.asr && <p className="hint">Heard by {out.asr}</p>}
          {out.transcript && <Booked result={out} />}
        </div>
      )}
    </Panel>
  );
}
