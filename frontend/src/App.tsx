import { useCallback, useEffect, useRef, useState } from "react";
import { api, Health, LedgerEvent, Summary } from "./api";
import { isUdhaar } from "./derive";
import { Icon, Mark } from "./icons";
import Books from "./views/Books";
import Devices from "./views/Devices";
import Entries from "./views/Entries";
import Record from "./views/Record";
import StartDay from "./views/StartDay";
import Stock from "./views/Stock";
import Today from "./views/Today";
import Udhaar from "./views/Udhaar";
import Words from "./views/Words";

export type Data = {
  health: Health | null;
  summary: Summary | null;
  events: LedgerEvent[];
  offline: string | null;
  loaded: boolean;
  refresh: () => void;
  go: (route: Route, arg?: string) => void;
};

const ROUTES = {
  start: { label: "Morning & evening stock", icon: Icon.record, group: "Shop" },
  today: { label: "Today", icon: Icon.today, group: "Shop" },
  record: { label: "Record a trade", icon: Icon.record, group: "Shop" },
  entries: { label: "Entries", icon: Icon.entries, group: "Shop" },
  udhaar: { label: "Udhaar book", icon: Icon.udhaar, group: "Shop" },
  stock: { label: "Stock and waste", icon: Icon.stock, group: "Shop" },
  books: { label: "Books", icon: Icon.books, group: "Accounts" },
  words: { label: "Shop words", icon: Icon.words, group: "Setup" },
  devices: { label: "Family devices", icon: Icon.devices, group: "Setup" },
} as const;
export type Route = keyof typeof ROUTES;

function readHash(): { route: Route; arg?: string } {
  const [r, arg] = window.location.hash.replace(/^#\/?/, "").split("/");
  return { route: (r in ROUTES ? r : "today") as Route, arg: arg ? decodeURIComponent(arg) : undefined };
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [offline, setOffline] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loc, setLoc] = useState(readHash);
  const [menuOpen, setMenuOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [h, s, ev] = await Promise.all([api.health(), api.summary(), api.events()]);
      setHealth(h);
      setSummary(s);
      setEvents(ev);
      setOffline(null);
    } catch (e) {
      setOffline(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500); // peers and the mic add events in the background
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const on = () => {
      setLoc(readHash());
      setMenuOpen(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    document.title = `${ROUTES[loc.route].label} · Invisible Worker`;
  }, [loc.route]);

  // Drawer: Escape closes it, focus moves in on open and back to the hamburger on close.
  const openRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (menuOpen) closeRef.current?.focus();
    else if (wasOpen.current) openRef.current?.focus();
    wasOpen.current = menuOpen;
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  const go = useCallback((route: Route, arg?: string) => {
    window.location.hash = `/${route}${arg ? `/${encodeURIComponent(arg)}` : ""}`;
  }, []);

  const data: Data = { health, summary, events, offline, loaded, refresh, go };
  const udhaarDisputes = (summary?.conflicts ?? []).filter((c) => isUdhaar(c.kind) && c.party).length;
  const booksDecisions = (summary?.conflicts.length ?? 0) - udhaarDisputes + (summary?.possible_duplicates.length ?? 0);
  const disputes = udhaarDisputes + booksDecisions;
  const badge: Partial<Record<Route, number>> = { udhaar: udhaarDisputes, books: booksDecisions };

  const nav = (
    <nav className="nav" aria-label="Main">
      {(["Shop", "Accounts", "Setup"] as const).map((g) => (
        <div key={g} className="nav-group">
          <div className="nav-label">{g}</div>
          {(Object.keys(ROUTES) as Route[])
            .filter((r) => ROUTES[r].group === g)
            .map((r) => {
              const I = ROUTES[r].icon;
              return (
                <a key={r} href={`#/${r}`} className={`nav-item ${loc.route === r ? "on" : ""}`} aria-current={loc.route === r ? "page" : undefined}>
                  <I />
                  <span>{ROUTES[r].label}</span>
                  {(badge[r] ?? 0) > 0 && <span className="nav-count" title={`${badge[r]} to settle or decide`}>{badge[r]}</span>}
                </a>
              );
            })}
        </div>
      ))}
    </nav>
  );

  const status = (
    <div className="side-status">
      <span className={`dot ${offline ? "bad" : summary?.balanced === false ? "bad" : "good"}`} aria-hidden="true" />
      <span>
        {offline ? "Ledger not reachable" : !summary ? "Connecting…" : summary.balanced ? "Books balance" : "Books do not balance"}
      </span>
    </div>
  );

  return (
    <div className="shell">
      <header className="topbar">
        <button ref={openRef} className="icon-btn" aria-label="Open menu" aria-expanded={menuOpen} aria-controls="drawer" onClick={() => setMenuOpen(true)}>
          <Icon.menu />
        </button>
        <a className="brand" href="#/today" aria-label="Invisible Worker, today">
          <Mark size={24} />
          <span className="brand-name">Invisible Worker</span>
        </a>
        <span className="topbar-sep" aria-hidden="true" />
        <b className="topbar-title">{ROUTES[loc.route].label}</b>
        {disputes > 0 && (
          <a className="nav-count topbar-count" href="#/today" title={`${disputes} to settle or decide (listed under Needs you)`}>
            {disputes}
          </a>
        )}
      </header>

      <div className={`backdrop ${menuOpen ? "open" : ""}`} onClick={() => setMenuOpen(false)} aria-hidden="true" />
      <aside
        id="drawer"
        className={`drawer ${menuOpen ? "open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        aria-hidden={!menuOpen}
        // closed drawer stays mounted for its slide, but out of the tab order
        {...(!menuOpen ? { inert: "" } : {})}
      >
        <div className="drawer-head">
          <a className="brand" href="#/today">
            <Mark />
            <span>
              <b>Invisible Worker</b>
              <small>{health ? `${health.device_id} · this phone` : "offline ledger"}</small>
            </span>
          </a>
          <button ref={closeRef} className="icon-btn" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            <Icon.close />
          </button>
        </div>
        {nav}
        {status}
      </aside>

      <main className="canvas" id="main">
        {offline && loaded && (
          <div className="notice bad" role="alert">
            The ledger on this laptop is not answering. Start it with <code>cd backend; uv run uvicorn app.main:app --port 8000</code>, then
            this page reconnects by itself.
          </div>
        )}
        {health?.model_mode === "demo" && (
          <div className="notice">
            Practice mode: listening, slip reading and the language model are stand-ins until the models are installed. The ledger, the
            maths and family sync are real.
          </div>
        )}
        {loc.route === "start" && <StartDay {...data} mode={loc.arg} />}
        {loc.route === "today" && <Today {...data} />}
        {loc.route === "record" && <Record {...data} tab={loc.arg} />}
        {loc.route === "entries" && <Entries {...data} selected={loc.arg} />}
        {loc.route === "udhaar" && <Udhaar {...data} />}
        {loc.route === "stock" && <Stock {...data} />}
        {loc.route === "books" && <Books {...data} />}
        {loc.route === "words" && <Words {...data} />}
        {loc.route === "devices" && <Devices {...data} />}
        <footer className="foot">Everything stays on this phone and the family's own network. Raw audio is never kept.</footer>
      </main>
    </div>
  );
}
