// The guardian's decision logic. Pure functions over decoded data: no I/O, no
// clock, no LLM. If a rule returns a hit, the guardian vetoes; nothing else
// can make it veto.

import { PAUSABLE_TAG, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type Proposal, type TargetIx } from "./decode.ts";

export type Severity = "critical" | "high";
export type Facts = Record<string, string | number | boolean | null>;
export type Hit = { rule: string; severity: Severity; facts: Facts };

export const DAY = 86_400;
export const WINDOW = 7 * DAY;

export type Ctx = {
  /** Unix seconds. */
  now: number;
  /** Decimals of the mint the instruction touches, if any. */
  decimals?: number;
  /** Current supply of that mint. */
  supply?: bigint;
  /** The mint's Reserve account (SPEC v2), when one exists. */
  reserve?: { amount: bigint; updatedAt: number };
  /** Executed mints of the same mint: amount and time (proposal eta). */
  mintHistory: { amount: bigint; at: number }[];
  /** list_collateral only: when the new collateral mint first appeared onchain; null if never seen. */
  collateralMintCreatedAt?: number | null;
  /** set_withdraw_limit only: the vault's current limit. */
  currentWithdrawLimit?: bigint;
  /** Times proposer / approver / guardian changed. */
  roleChanges: { role: string; at: number }[];
  /** Mint is suspicious above this multiple of the trailing 7-day average. */
  mintMultiple: number;
  /** Absolute per-mint ceiling, in whole tokens. */
  mintCeilingTokens: bigint;
};

const MINTS = new Set(["MintTo", "MintToChecked"]);

/** Formats base units as whole tokens, e.g. 80000000000000n with 6 decimals -> "80,000,000". */
export function ui(amount: bigint, decimals = 0): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = BigInt(s.slice(0, s.length - decimals)).toLocaleString("en-US");
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function mintSize(_p: Proposal, ix: TargetIx, ctx: Ctx): Hit | null {
  if (!MINTS.has(ix.name) || ix.amount === undefined) return null;
  const decimals = ix.decimals ?? ctx.decimals ?? 0;
  const amount = ix.amount;
  const ceiling = ctx.mintCeilingTokens * 10n ** BigInt(decimals);
  if (amount > ceiling) {
    return {
      rule: "mint_over_ceiling",
      severity: "critical",
      facts: { instruction: ix.name, mint: ix.mint ?? null, amount: ui(amount, decimals), ceiling: ui(ceiling, decimals) },
    };
  }
  const recent = ctx.mintHistory.filter((m) => m.at > ctx.now - WINDOW && m.at <= ctx.now);
  if (recent.length === 0) return null;
  const avg = recent.reduce((s, m) => s + m.amount, 0n) / BigInt(recent.length);
  // Compare in integers: amount > multiple * avg, with the multiple in hundredths.
  const scaled = BigInt(Math.round(ctx.mintMultiple * 100));
  if (amount * 100n <= scaled * avg) return null;
  return {
    rule: "mint_over_average",
    severity: "high",
    facts: {
      instruction: ix.name,
      mint: ix.mint ?? null,
      amount: ui(amount, decimals),
      avg_7d: ui(avg, decimals),
      mints_7d: recent.length,
      multiple: ctx.mintMultiple,
    },
  };
}

export function mintUnbacked(_p: Proposal, ix: TargetIx, ctx: Ctx): Hit | null {
  if (!MINTS.has(ix.name) || ix.amount === undefined || !ctx.reserve || ctx.supply === undefined) return null;
  const headroom = ctx.reserve.amount - ctx.supply;
  if (ix.amount <= headroom) return null;
  const d = ix.decimals ?? ctx.decimals ?? 0;
  return {
    rule: "mint_unbacked",
    severity: "critical",
    facts: {
      instruction: ix.name,
      mint: ix.mint ?? null,
      amount: ui(ix.amount, d),
      supply: ui(ctx.supply, d),
      attested_reserves: ui(ctx.reserve.amount, d),
      headroom: headroom < 0n ? `-${ui(-headroom, d)}` : ui(headroom, d),
      unbacked: ui(ix.amount - (headroom > 0n ? headroom : 0n), d),
      reserve_updated_at: new Date(ctx.reserve.updatedAt * 1000).toISOString(),
    },
  };
}

export function authorityChange(p: Proposal, ix: TargetIx, _ctx: Ctx): Hit | null {
  if (ix.name === "SetAuthority") {
    return {
      rule: "set_authority",
      severity: "critical",
      facts: { program: ix.program, target: ix.mint ?? null, authority_type: ix.authorityType ?? null, new_authority: ix.newAuthority ?? null },
    };
  }
  // Every change to Vetowall's own config is `Max` by construction, so the class alone says nothing there;
  // `policyWeakening` judges those by what they change.
  if (p.class === "Max" && ix.program !== "vetowall") {
    return { rule: "max_class", severity: "high", facts: { program: p.targetProgram, instruction: ix.name, class: p.class } };
  }
  return null;
}

export function vaultRisk(_p: Proposal, ix: TargetIx, ctx: Ctx): Hit | null {
  if (ix.program !== "mock_vault") return null;
  if (ix.name === "list_collateral" && ctx.collateralMintCreatedAt !== undefined) {
    const created = ctx.collateralMintCreatedAt;
    if (created !== null && ctx.now - created >= WINDOW) return null;
    return {
      rule: "young_collateral",
      severity: "critical",
      facts: {
        collateral_mint: String(ix.args?.mint),
        mint_age_days: created === null ? null : +((ctx.now - created) / DAY).toFixed(2),
        price: String(ix.args?.price),
        weight_bps: Number(ix.args?.weight_bps),
      },
    };
  }
  if (ix.name === "set_withdraw_limit" && ctx.currentWithdrawLimit !== undefined) {
    const next = BigInt(ix.args?.withdraw_limit);
    if (next <= 5n * ctx.currentWithdrawLimit) return null;
    const cur = ctx.currentWithdrawLimit;
    return {
      rule: "withdraw_limit_jump",
      severity: "high",
      facts: {
        current_limit: cur.toString(),
        new_limit: next.toString(),
        multiple: cur === 0n ? null : Number((next * 100n) / cur) / 100,
      },
    };
  }
  return null;
}

export function recentRoleChange(p: Proposal, _ix: TargetIx, ctx: Ctx): Hit | null {
  const change = ctx.roleChanges
    .filter((c) => c.at <= p.queuedAt && p.queuedAt - c.at < WINDOW)
    .sort((a, b) => b.at - a.at)[0];
  if (!change) return null;
  return {
    rule: "recent_role_change",
    severity: "high",
    facts: {
      role: change.role,
      changed_at: new Date(change.at * 1000).toISOString(),
      queued_at: new Date(p.queuedAt * 1000).toISOString(),
      hours_after_change: +((p.queuedAt - change.at) / 3600).toFixed(1),
    },
  };
}

/**
 * A queued `register` that would take the brakes off a token instruction:
 * a mint, burn, authority change or resume made `Safe` (no timelock, and the
 * guardian key itself could then run it), or a mint policy without a reserve
 * bound. With the proposer and approver compromised this is the quiet first
 * step, weeks before any mint.
 */
export function policyWeakening(_p: Proposal, ix: TargetIx, _ctx: Ctx): Hit | null {
  if (ix.program !== "vetowall" || ix.name !== "register" || !ix.args) return null;
  const { target_program, discriminator: d, class: cls, limit } = ix.args;
  if (target_program !== TOKEN_PROGRAM && target_program !== TOKEN_2022_PROGRAM) return null;
  const mints = d[0] === 7 || d[0] === 14;
  // SetAuthority, Burn, BurnChecked, and every Pausable policy except Pause itself. That includes the bare
  // one-byte tag, which matches Resume too until a two-byte sibling is registered.
  const guarded = mints || d[0] === 6 || d[0] === 8 || d[0] === 15 || (d[0] === PAUSABLE_TAG && d[1] !== 1);
  if (!guarded) return null;
  const unbounded = mints && !limit?.reserve;
  if (cls !== "Safe" && !unbounded) return null;
  return {
    rule: "policy_weakening",
    severity: "critical",
    facts: { tag: d[0], sub_tag: d[1], new_class: cls, reserve_bound: Boolean(limit?.reserve), cap: limit ? String(limit.cap) : null },
  };
}

export const RULES = [mintUnbacked, mintSize, authorityChange, vaultRisk, policyWeakening, recentRoleChange];
const RANK: Record<Severity, number> = { critical: 0, high: 1 };

/**
 * All hits for a queued proposal, most severe first. A queued `set_guardian`
 * returns nothing: the program refuses to let the guardian veto its own
 * rotation, so a veto would only fail.
 */
export function evaluate(p: Proposal, ix: TargetIx, ctx: Ctx, vetowall: string): Hit[] {
  if (p.status !== "Queued") return [];
  if (p.targetProgram === vetowall && ix.name === "set_guardian") return [];
  return RULES.map((r) => r(p, ix, ctx))
    .filter((h): h is Hit => h !== null)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}
