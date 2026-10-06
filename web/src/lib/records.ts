// Onchain change records (the program's `ChangeRecord` event, docs/SPEC.md
// "Events") and refused transactions, mapped into timeline/report actions.
// Pure: no RPC, no IDL import, so records.test.ts runs under plain node.
import type { Action, ActionClass, Path } from './model.ts';

export const PROGRAM = 'G8LSBa3y5XqY5fK4R6NTK84oPru3W3hsNzRwjunLWedr';
export const TOKEN_2022_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const TOKEN_LABELS: Record<number, string> = {
  6: 'Change authority', 7: 'Mint', 8: 'Burn (permanent delegate)', 10: 'Freeze account',
  11: 'Thaw account', 14: 'Mint (checked)', 15: 'Burn, checked (permanent delegate)',
};

/** Plain-English label, affected account and amount of a routed instruction. */
export function describe(target: string, data: ArrayLike<number>, accounts: { pubkey: { toString(): string } }[], decimals: number) {
  if (target === PROGRAM) return { action: 'Vetowall config change' };
  if (target !== TOKEN_2022_ID) return { action: `Call to ${target.slice(0, 4)}…` };
  if (data[0] === 44) return { action: data[1] === 1 ? 'Pause transfers' : 'Resume transfers' };
  const hasAmount = [7, 8, 14, 15].includes(data[0]) && data.length >= 9;
  return {
    action: TOKEN_LABELS[data[0]] ?? `Token-2022 instruction ${data[0]}`,
    subject: accounts[data[0] === 7 || data[0] === 14 ? 1 : 0]?.pubkey.toString(),
    amount: hasAmount ? Number(new DataView(Uint8Array.from(data).buffer).getBigUint64(1, true)) / 10 ** decimals : undefined,
  };
}

// Values as the IDL's event coder returns them: PublicKey, BN, enum objects.
type Key = { toString(): string };
type Num = { toString(): string };
export interface DecodedRecord {
  kind: Record<string, object>;
  config: Key;
  proposalId: Num | null;
  targetProgram: Key;
  discriminator: number[];
  amount: Num | null;
  class: Record<string, object> | null;
  actor: Key;
  approver: Key | null;
  subject: Key | null;
  reason: number[];
  timestamp: Num;
}

/** The stored instruction the transaction routed, when its outer instruction could be decoded. */
export interface Routed {
  accounts: { pubkey: Key }[];
  data: ArrayLike<number>;
}

const variant = (e: object) => Object.keys(e)[0];
const toClass = (c: object | null): ActionClass | undefined => {
  const v = c && variant(c);
  return v ? ((v[0].toUpperCase() + v.slice(1)) as ActionClass) : undefined;
};

const GOVERNANCE: Record<string, (r: DecodedRecord) => string> = {
  initialized: () => 'Config created',
  reserveInitialized: () => 'Reserve account created',
  attestorSet: () => 'Attestor changed',
  registered: (r) => `Policy registered: ${describe(r.targetProgram.toString(), r.discriminator, [], 0).action}`,
  sealed: () => 'Config sealed',
  proposerSet: () => 'Proposer changed',
  approverSet: (r) => (r.subject ? 'Approver changed' : 'Approver removed'),
  guardianSet: () => 'Guardian changed',
  delaysSet: () => 'Delays changed',
};

/**
 * One timeline/report action per record. Proposal records (queued, executed,
 * vetoed) return null: the Proposal account carries their full state,
 * including `executed_at`.
 */
export function recordToAction(r: DecodedRecord, tx: string, decimals: number, routed?: Routed): Action | null {
  const kind = variant(r.kind);
  const at = Number(r.timestamp.toString());
  const unit = 10 ** decimals;
  const amount = r.amount === null ? undefined : Number(r.amount.toString()) / unit;
  const base = {
    id: null,
    status: 'executed' as const,
    queuedAt: at,
    eta: at,
    executedAt: at,
    maker: r.actor.toString(),
    tx,
  };
  if (kind === 'executedNow' || kind === 'guardianExecuted') {
    const target = r.targetProgram.toString();
    const d = describe(target, routed?.data ?? r.discriminator, routed?.accounts ?? [], decimals);
    return {
      ...base,
      ...d,
      amount: amount ?? d.amount,
      path: kind === 'executedNow' ? 'fast lane' : 'guardian',
      class: toClass(r.class),
      checker: r.approver?.toString(),
    };
  }
  if (kind === 'reserveAttested') {
    return { ...base, path: 'attestor', action: 'Reserve attested', subject: r.subject?.toString(), amount };
  }
  const label = GOVERNANCE[kind];
  if (!label) return null;
  return {
    ...base,
    path: 'governance' as Path,
    action: label(r),
    class: toClass(r.class),
    subject: r.subject?.toString(),
    note: kind === 'registered' && amount !== undefined ? `Fast-lane cap ${amount.toLocaleString('en-US')} per window` : undefined,
  };
}

/** A fast-lane attempt the program refused: the failed transaction is the record. */
export function refusedAction(
  args: { targetProgram: Key; accounts: { pubkey: Key }[]; data: ArrayLike<number> },
  signers: { proposer: string; approver?: string },
  error: string,
  blockTime: number,
  tx: string,
  decimals: number,
): Action {
  return {
    id: null,
    path: 'fast lane',
    ...describe(args.targetProgram.toString(), args.data, args.accounts, decimals),
    status: 'refused',
    queuedAt: blockTime,
    eta: blockTime,
    maker: signers.proposer,
    checker: signers.approver,
    note: `Refused onchain (${error})`,
    tx,
  };
}

/** The Anchor error name in a failed transaction's logs. */
export const errorName = (logs: string[]) =>
  logs.join('\n').match(/Error Code: (\w+)/)?.[1] ?? 'failed';
