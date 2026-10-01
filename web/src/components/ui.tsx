'use client';
// Small shared pieces: addresses, status marks, panels, figures, task status.
import { useState, type ReactNode } from 'react';
import { explorer } from '@/src/lib/explorer';
import type { Action } from '@/src/lib/model';

export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Runs one async action at a time and keeps its progress and result for display. */
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
export type Task = ReturnType<typeof useTask>;

export function TaskStatus({ task }: { task: Task }) {
  return (
    <div role="status" aria-live="polite">
      {task.busy && <p className="status-line">{task.busy}…</p>}
      {task.error && (
        <p className="status-line error">
          <Icon name="x" /> <span>{task.error}</span>
        </p>
      )}
      {task.done && (
        <p className="status-line ok">
          <Icon name="check" /> <span>{task.done}</span>
        </p>
      )}
    </div>
  );
}

const PATHS = {
  check: 'M3.5 8.5l3 3 6-7',
  x: 'M4.5 4.5l7 7m0-7l-7 7',
  clock: 'M8 4.5V8l2.5 1.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z',
  stop: 'M3.8 3.8l8.4 8.4M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z',
  dot: 'M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z',
  flask: 'M6 2.5h4M6.5 2.5v4L3 13a1 1 0 0 0 .9 1.5h8.2A1 1 0 0 0 13 13L9.5 6.5v-4',
  external: 'M9.5 3H13v3.5M13 3L7.5 8.5M11 9.5V13H3V5h3.5',
};

export function Icon({ name, size = 14 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

const MARK: Record<Action['status'], { icon: keyof typeof PATHS; label: string }> = {
  executed: { icon: 'check', label: 'Executed' },
  queued: { icon: 'clock', label: 'In timelock' },
  vetoed: { icon: 'stop', label: 'Vetoed' },
  refused: { icon: 'x', label: 'Refused' },
};

/** A status stamp: icon plus word, never colour alone. */
export function Mark({ status }: { status: Action['status'] }) {
  const m = MARK[status];
  return (
    <span className={`mark mark-${status}`}>
      <Icon name={m.icon} size={12} />
      {m.label}
    </span>
  );
}

/** Where the figures come from: live devnet, or labelled sample data. */
export function SourceBadge({ live, label }: { live: boolean; label?: string }) {
  return (
    <span className={`source ${live ? 'source-live' : 'source-demo'}`}>
      <Icon name={live ? 'dot' : 'flask'} size={12} />
      {label ?? (live ? 'Live · devnet' : 'Sample data')}
    </span>
  );
}

/** An address or signature: an Explorer link when live, plain text for sample data (it isn't onchain). */
export function Addr({ value, live, kind = 'address', label }: { value: string; live: boolean; kind?: 'address' | 'tx'; label?: string }) {
  if (!live) return <code className="addr" title={`${value} (sample data, not onchain)`}>{label ?? short(value)}</code>;
  return (
    <a className="addr" href={explorer(kind, value)} target="_blank" rel="noreferrer" title={value}>
      {label ?? short(value)}
      <span className="sr-only"> (opens Solana Explorer)</span>
    </a>
  );
}

export function Panel({ title, children, aside, id }: { title: string; children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <section className="panel" aria-labelledby={id}>
      <header className="panel-head">
        <h2 id={id}>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ? `tone-${tone}` : ''}`}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/** A filled bar for a used/total figure; the numbers are always printed next to it. */
export function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="bar" role="img" aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function PageHead({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      <p className="lede">{children}</p>
    </div>
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
