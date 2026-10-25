import { useEffect, useState } from "react";
import { api, LedgerEvent } from "./api";

// Skeleton dashboard. Planned panels (stage 7): live mic transcript, slip upload + confirm,
// profit range chart, credit book, loss attribution, 3-device sync view, Lexicon Drop editor.
export default function App() {
  const [deviceId, setDeviceId] = useState("…");
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [balanced, setBalanced] = useState(true);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [h, ev, b] = await Promise.all([api.health(), api.events(), api.balances()]);
      setDeviceId(h.device_id);
      setEvents(ev);
      setBalances(b.balances_paise);
      setBalanced(b.balanced);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, []);

  async function submit() {
    if (!text.trim()) return;
    try {
      await api.ingestText(text);
      setText("");
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 960, margin: "0 auto", padding: 16 }}>
      <h1>Invisible Worker · {deviceId}</h1>
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      <section>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Bhai 3 kilo tamatar liya 180 mein…"
          style={{ width: "70%" }}
        />
        <button onClick={submit}>Add</button>
        <button onClick={() => api.syncNow().then(refresh)}>Sync now</button>
      </section>

      <h2>Balances {balanced ? "✅ balanced" : "❌ unbalanced"}</h2>
      <ul>
        {Object.entries(balances).map(([acct, paise]) => (
          <li key={acct}>
            {acct}: ₹{(paise / 100).toFixed(2)}
          </li>
        ))}
      </ul>

      <h2>Event log ({events.length})</h2>
      <ul>
        {events.map((e) => (
          <li key={e.id}>
            <code>{e.id}</code> {e.kind} via {e.source} ({Math.round(e.confidence * 100)}%) — {e.raw}
          </li>
        ))}
      </ul>
    </main>
  );
}
