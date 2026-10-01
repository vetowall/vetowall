// Small shared pieces: addresses, status pills, countdowns, the timeline.
import { useEffect, useState, type ReactNode } from 'react';
import { explorer } from './chain';
import { fmtAmount, fmtDuration, fmtShort, fmtTime, type Action, type Path, type Snapshot } from './model';

const PATH_LABELS: Record<Path, string> = {
  'fast lane': 'Fast lane', timelock: 'Timelock', guardian: 'Guardian action', attestor: 'Reserve attestation', governance: 'Config change',
};

export function useNow() {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Runs one async action at a time and keeps its progress and error for display. */
export function useTask() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(label);
    setError(null);
    setDone(null);
    try {
      setDone((await fn()) || null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }
  return { busy, error, done, run, setError };
}

export function TaskStatus({ task }: { task: ReturnType<typeof useTask> }) {
  return (
    <div aria-live="polite">
      {task.busy && <p className="note">{task.busy}…</p>}
      {task.error && <p className="error" role="alert">{task.error}</p>}
      {task.done && <p className="ok">{task.done}</p>}
    </div>
  );
}

export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function Addr({ value, live, kind = 'address' }: { value: string; live: boolean; kind?: 'address' | 'tx' }) {
  if (!live) return <code className="addr" title={`${value} (demo data)`}>{short(value)}</code>;
  return (
    <a className="addr" href={explorer(kind, value)} target="_blank" rel="noreferrer" title={value}>
      {short(value)}
    </a>
  );
}

export function Pill({ status }: { status: Action['status'] }) {
  return <span className={`pill pill-${status}`}>{status}</span>;
}

export function Card({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'warn' }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Timeline({
  snap,
  limit,
  actionFor,
}: {
  snap: Snapshot;
  limit?: number;
  /** Optional button for a row, e.g. execute or veto. */
  actionFor?: (a: Action, now: number) => ReactNode;
}) {
  const now = useNow();
  const live = snap.source === 'live';
  const rows = [...snap.actions].sort((a, b) => b.queuedAt - a.queuedAt).slice(0, limit);
  if (!rows.length) return <p className="note">No actions yet. Propose a mint above and it will show up here.</p>;
  return (
    <ol className="timeline">
      {rows.map((a, i) => {
        const left = a.eta - now;
        return (
          <li key={`${a.id}-${a.tx}-${i}`} className={`tl tl-${a.status}`}>
            <div className="tl-main">
              <div className="tl-title">
                <Pill status={a.status} />
                <strong>
                  {a.action}
                  {a.amount !== undefined && ` ${a.amount >= 1e9 ? fmtShort(a.amount) : fmtAmount(a.amount)} ${snap.deployment.symbol}`}
                </strong>
              </div>
              <div className="tl-meta">
                {a.id !== null ? `Proposal #${a.id}` : PATH_LABELS[a.path]} · {a.class && `${a.class} class · `}
                {fmtTime(a.queuedAt)}
                {a.subject && <> · <Addr value={a.subject} live={live} /></>}
              </div>
              {a.note && <div className="tl-note">{a.note}</div>}
            </div>
            <div className="tl-side">
              {a.status === 'queued' &&
                (left > 0 ? (
                  <span className="countdown" aria-label={`Runs in ${fmtDuration(left)}`}>
                    <span className="countdown-label">runs in</span> {fmtDuration(left)}
                  </span>
                ) : (
                  <span className="countdown ready">ready to execute</span>
                ))}
              {actionFor?.(a, now)}
              {a.address ? <Addr value={a.address} live={live} /> : a.tx ? <Addr value={a.tx} kind="tx" live={live} /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function download(name: string, type: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
export const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
