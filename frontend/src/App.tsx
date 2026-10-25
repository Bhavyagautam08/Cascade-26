import { useCallback, useEffect, useState } from "react";
import { api, Health, LedgerEvent, Summary } from "./api";
import Capture from "./panels/Capture";
import EventLog from "./panels/EventLog";
import LexiconDrop from "./panels/LexiconDrop";
import { CreditBook, ProfitRange, TrialBalance } from "./panels/Ledger";
import Sync from "./panels/Sync";
import Wastage from "./panels/Wastage";

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [offline, setOffline] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [h, s, ev] = await Promise.all([api.health(), api.summary(), api.events()]);
      setHealth(h);
      setSummary(s);
      setEvents(ev);
      setOffline(null);
    } catch (e) {
      setOffline(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500);   // peers and the mic add events in the background
    return () => clearInterval(t);
  }, [refresh]);

  const demo = health?.model_mode === "demo";
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <h1>Invisible Worker</h1>
          <span className="sub">offline probabilistic ledger</span>
        </div>
        <div className="chips">
          {health && <span className="chip info">{health.device_id}</span>}
          {health &&
            (demo ? (
              <span className="chip warn" title="models not loaded: stand-ins in perception/demo.py">demo models</span>
            ) : health.llm_ready ? (
              <span className="chip good" title={health.whisper_model}>{health.llm_model} ready</span>
            ) : (
              <span className="chip bad" title="Ollama not reachable or model missing: rule parser in use">LLM offline · rules</span>
            ))}
          {health && <span className={`chip ${health.mic_listening ? "good" : ""}`}>{health.mic_listening ? "mic on" : "mic off"}</span>}
          {summary && <span className={`chip ${summary.balanced ? "good" : "bad"}`}>{summary.balanced ? "books balance" : "UNBALANCED"}</span>}
          {summary && summary.conflicts.length > 0 && <span className="chip warn">{summary.conflicts.length} in suspense</span>}
        </div>
      </header>

      <main className="page">
        {offline && <div className="banner bad">Backend not reachable on this laptop ({offline}). Start it: cd backend; uv run uvicorn app.main:app --port 8000</div>}
        {demo && (
          <div className="banner">
            Demo mode: speech, slip reading and the LLM are stand-ins until the models finish installing (set MODEL_MODE=real in
            backend\.env). Ledger, fusion, inference and sync are the real thing.
          </div>
        )}

        <div className="grid">
          <div className="col">
            <Capture health={health} onChange={refresh} />
            <LexiconDrop onChange={refresh} />
            <Sync health={health} summary={summary} onChange={refresh} />
          </div>
          <div className="col">
            <ProfitRange summary={summary} />
            <CreditBook summary={summary} onChange={refresh} />
            <TrialBalance summary={summary} />
          </div>
          <Wastage />
          <EventLog events={events} summary={summary} onChange={refresh} />
        </div>
        <div className="footer">Runs entirely on this device and the family's local network. Raw audio is never stored.</div>
      </main>
    </>
  );
}
