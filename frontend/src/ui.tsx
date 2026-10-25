import { ReactNode, useState } from "react";
import { KIND_LABEL } from "./derive";
import { Icon } from "./icons";

export function Panel(props: {
  title: string;
  aside?: ReactNode;
  note?: ReactNode;
  className?: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <section id={props.id} className={`panel ${props.className ?? ""}`} aria-label={props.title}>
      <header className="panel-head">
        <div>
          <h2>{props.title}</h2>
          {props.note && <p className="panel-note">{props.note}</p>}
        </div>
        {props.aside && <div className="panel-aside">{props.aside}</div>}
      </header>
      {props.children}
    </section>
  );
}

/** Title row of a view: the h1, one sentence about the data, and real actions only. */
export function ViewHead({ title, line, actions }: { title: string; line?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="view-head">
      <div>
        <h1>{title}</h1>
        {line && <p className="view-line">{line}</p>}
      </div>
      {actions && <div className="view-actions">{actions}</div>}
    </div>
  );
}

/** How sure the worker was. Only doubt gets a colour; certainty stays in ink. */
export function Conf({ value }: { value: number }) {
  const low = value < 0.6;
  return (
    <span className={`conf ${low ? "low" : ""}`} title={`${Math.round(value * 100)}% sure`}>
      <span className="conf-track" aria-hidden="true">
        <i style={{ transform: `scaleX(${Math.max(0.02, value)})` }} />
      </span>
      <span className="num">{Math.round(value * 100)}%</span>
    </span>
  );
}

export function KindTag({ kind }: { kind: string }) {
  return <span className={`tag kind-${kind}`}>{KIND_LABEL[kind] ?? kind}</span>;
}

export function Pill({ tone = "neutral", children, title }: { tone?: "neutral" | "positive" | "negative" | "warning"; children: ReactNode; title?: string }) {
  return (
    <span className={`pill ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Segmented<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="tablist" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={props.value === o.value}
          className={props.value === o.value ? "on" : ""}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** A grey bar at the real size of the value it stands in for, while data loads. */
export function Skeleton({ w = "60%", h = 14 }: { w?: string | number; h?: number }) {
  return <span className="skeleton" style={{ width: w, height: h }} aria-hidden="true" />;
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
  return error ? (
    <div className="error-line" role="alert">
      <Icon.alert /> <span>{error}</span>
    </div>
  ) : null;
}
