// Plain view types shared by the pages, the demo data and the report.
// Nothing here knows about the IDL; src/vetowall.ts maps accounts into these.

export type ActionClass = 'Safe' | 'Params' | 'Authority' | 'Max';
export type Status = 'queued' | 'executed' | 'vetoed' | 'refused';
export type Path = 'fast lane' | 'timelock' | 'guardian' | 'attestor' | 'governance';

export interface Action {
  /** Proposal id; null when no Proposal account exists (every path but the timelock). */
  id: number | null;
  /** Proposal PDA, if any. */
  address?: string;
  path: Path;
  /** Plain-English name, e.g. "Mint", "Freeze account". */
  action: string;
  /** Account the action touches (mint destination, frozen account). */
  subject?: string;
  /** Token amount in whole units. */
  amount?: number;
  /** Unset for reserve and setup records, which aren't routed through a policy. */
  class?: ActionClass;
  status: Status;
  /** Unix seconds: when it was requested (queued, or the record's own time). */
  queuedAt: number;
  eta: number;
  /** Unix seconds, from the Proposal's `executed_at` or the record's timestamp. */
  executedAt?: number;
  maker?: string;
  checker?: string;
  /** Hex SHA-256 of the guardian's explanation. */
  vetoReason?: string;
  /** Why it was refused or vetoed, in plain words. */
  note?: string;
  tx?: string;
}

export interface Deployment {
  config: string;
  authority: string;
  mint: string;
  symbol: string;
  decimals: number;
  proposer: string;
  approver?: string;
  guardian: string;
  attestor?: string;
  /** Seconds per class: Safe, Params, Authority, Max. */
  delays: [number, number, number, number];
}

export interface Snapshot {
  source: 'live' | 'demo';
  deployment: Deployment;
  actions: Action[];
  supply: number;
  reserve: { amount: number; updatedAt: number; maxAge: number } | null;
  cap: { cap: number; used: number; windowStart: number; window: number } | null;
  /** Every Token-2022 authority on the mint and who holds it. */
  authorities: { name: string; holder: string | null }[];
  paused: boolean;
}

export interface Decision {
  ts: string;
  proposal: string;
  id: number;
  rule: string;
  explanation: string;
  reason_hash: string;
  veto_tx: string;
}

export const CLASSES: ActionClass[] = ['Safe', 'Params', 'Authority', 'Max'];

export const fmtAmount = (n: number) =>
  n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** Compact money-style figure: 80M, 1.2B, 300T. */
export const fmtShort = (n: number) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export const fmtTime = (unix: number) =>
  new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

export function fmtDuration(secs: number) {
  if (secs <= 0) return '0s';
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60), s = Math.floor(secs % 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Holders that aren't the Vetowall authority PDA: each is a key that can act alone. */
export const godKeys = (s: Snapshot) =>
  s.authorities.filter((a) => a.holder !== null && a.holder !== s.deployment.authority).length;
