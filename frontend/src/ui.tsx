import { ReactNode, useState } from "react";

export function Card(props: { title: string; hint?: ReactNode; right?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`card ${props.className ?? ""}`}>
      <div className="card-head">
        <h2>{props.title}</h2>
        {props.hint && <span className="hint">{props.hint}</span>}
        {props.right && <div className="right">{props.right}</div>}
      </div>
      <div className="card-body">{props.children}</div>
    </section>
  );
}

export function confColor(c: number) {
  return c >= 0.75 ? "var(--good)" : c >= 0.5 ? "var(--warn)" : "var(--bad)";
}

export function Conf({ value }: { value: number }) {
  return (
    <span className="conf" title="confidence">
      <span className="bar">
        <i style={{ width: `${Math.round(value * 100)}%`, background: confColor(value) }} />
      </span>
      {Math.round(value * 100)}%
    </span>
  );
}

export function KindBadge({ kind }: { kind: string }) {
  const label: Record<string, string> = {
    purchase: "purchase",
    sale: "sale",
    credit_given: "udhaar",
    credit_paid: "jama",
    expense: "expense",
    stock_count: "stock",
    adjustment: "adjust",
  };
  return <span className={`badge ${kind}`}>{label[kind] ?? kind}</span>;
}

/** Run an async action with busy + error state, so every button reports failures in place. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <div className="result err">{error}</div> : null;
}
