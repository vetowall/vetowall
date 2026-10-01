// Change-control report: one row per privileged action, with each column
// tied to the control it evidences under the OCC's proposed 12 CFR 15.13
// (risk management and operational standards for payment stablecoin issuers:
// internal controls and information systems, internal audit, and key and
// incident handling). Pure functions so they can be tested without a browser.
import type { Action, Snapshot } from './model';

export interface Column {
  key: keyof Row;
  header: string;
  control: string;
}

export interface Row {
  change_id: string;
  requested_utc: string;
  action: string;
  subject: string;
  amount: string;
  path: string;
  risk_class: string;
  maker: string;
  checker: string;
  waiting_period_hours: string;
  earliest_effective_utc: string;
  executed_utc: string;
  outcome: string;
  independent_review: string;
  reserve_check: string;
  key_custody: string;
  evidence: string;
}

export const COLUMNS: Column[] = [
  { key: 'change_id', header: 'Change ID', control: 'Information systems: every change has a unique, immutable record' },
  { key: 'requested_utc', header: 'Requested (UTC)', control: 'Information systems: time of request' },
  { key: 'action', header: 'Action', control: 'Internal controls: what was changed' },
  { key: 'subject', header: 'Account affected', control: 'Internal controls: scope of change' },
  { key: 'amount', header: 'Amount', control: 'Internal controls: size of change' },
  { key: 'path', header: 'Approval path', control: 'Internal controls: risk-based approval route' },
  { key: 'risk_class', header: 'Risk class', control: 'Risk management: action classified by risk before it runs' },
  { key: 'maker', header: 'Maker', control: 'Internal controls: segregation of duties (requester)' },
  { key: 'checker', header: 'Checker', control: 'Internal controls: dual control (independent approver)' },
  { key: 'waiting_period_hours', header: 'Waiting period (h)', control: 'Risk management: review window before high-risk changes take effect' },
  { key: 'earliest_effective_utc', header: 'Earliest effective (UTC)', control: 'Information systems: enforced effective time' },
  { key: 'executed_utc', header: 'Executed (UTC)', control: 'Information systems: time the change took effect, recorded onchain' },
  { key: 'outcome', header: 'Outcome', control: 'Internal audit: final state of the change' },
  { key: 'independent_review', header: 'Guardian review', control: 'Internal audit / incident response: independent veto and its recorded reason' },
  { key: 'reserve_check', header: 'Reserve check', control: 'Internal controls: issuance bounded by attested reserves' },
  { key: 'key_custody', header: 'Key custody', control: 'Key management: no single private key can make the change' },
  { key: 'evidence', header: 'Onchain evidence', control: 'Internal audit: independently verifiable record' },
];

const iso = (unix: number) => new Date(unix * 1000).toISOString();
const explorer = (kind: 'address' | 'tx', id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

function reserveCheck(a: Action): string {
  if (a.action !== 'Mint') return 'n/a';
  if (a.status === 'refused') return 'Refused by program';
  if (a.status === 'vetoed') return 'Vetoed before execution';
  if (a.status === 'queued') return 'Re-checked at execution';
  return 'Within attested reserves';
}

function custody(a: Action, d: Snapshot['deployment']): string {
  if (a.path === 'attestor') return `Attestor key ${a.maker ?? ''}`;
  if (a.path === 'governance' && a.maker !== d.authority) return `Admin key ${a.maker ?? ''} (setup, before seal)`;
  return `Authority PDA ${d.authority}`;
}

export function reportRows(s: Snapshot): Row[] {
  const d = s.deployment;
  return [...s.actions]
    .sort((a, b) => a.queuedAt - b.queuedAt)
    .map((a) => ({
      change_id: a.id !== null ? `P-${a.id}` : `${a.path}:${a.tx?.slice(0, 8) ?? 'local'}${a.seq ? `/${a.seq}` : ''}`,
      requested_utc: iso(a.queuedAt),
      action: a.action,
      subject: a.subject ?? d.mint,
      amount: a.amount !== undefined ? `${a.amount} ${d.symbol}` : '',
      path: a.path,
      risk_class: a.class ?? 'n/a',
      maker: a.maker ?? '',
      checker: a.checker ?? (a.path === 'guardian' ? 'n/a (Safe action, guardian only)' : ''),
      waiting_period_hours: String(Math.round((a.eta - a.queuedAt) / 36) / 100),
      earliest_effective_utc: iso(a.eta),
      executed_utc: a.executedAt ? iso(a.executedAt) : '',
      outcome: a.status,
      independent_review:
        a.status === 'vetoed' ? `Vetoed; reason sha256 ${a.vetoReason ?? ''}` : a.path === 'timelock' ? 'No veto' : 'n/a',
      reserve_check: reserveCheck(a),
      key_custody: custody(a, d),
      evidence: a.address ? explorer('address', a.address) : a.tx ? explorer('tx', a.tx) : '',
    }));
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCSV(rows: Row[]): string {
  const lines = [COLUMNS.map((c) => cell(c.header)).join(',')];
  for (const r of rows) lines.push(COLUMNS.map((c) => cell(r[c.key])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function toJSON(s: Snapshot, generatedAt = new Date()): string {
  const d = s.deployment;
  return JSON.stringify(
    {
      report: 'Vetowall change-control report',
      regulation: 'OCC proposed 12 CFR 15.13, risk management and operational standards',
      generated_utc: generatedAt.toISOString(),
      data_source: s.source,
      cluster: 'devnet',
      program: 'G8LSBa3y5XqY5fK4R6NTK84oPru3W3hsNzRwjunLWedr',
      config: d.config,
      authority_pda: d.authority,
      mint: d.mint,
      delays_seconds: { safe: d.delays[0], params: d.delays[1], authority: d.delays[2], max: d.delays[3] },
      controls: Object.fromEntries(COLUMNS.map((c) => [c.key, c.control])),
      rows: reportRows(s),
    },
    null,
    2,
  );
}
