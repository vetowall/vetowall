// Decisions for `scripts/adopt.ts`, which puts an existing Token-2022 mint
// under Vetowall. Everything here is pure: arguments, environment and mint
// state come in, and a typed plan or an `AdoptError` comes out. We keep the
// RPC calls and the signing in the script, so every refusal below is tested
// without a cluster (`adopt.test.ts`).
//
// The handover this plans can't be undone quickly: once an authority sits on
// the Vetowall PDA it only leaves through a queued SetAuthority that waits out
// the Max delay. So we refuse anything we can't honour exactly, instead of
// filling in a default and moving the keys anyway.
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { AuthorityType, ExtensionType, TOKEN_2022_PROGRAM_ID, createSetAuthorityInstruction } from '@solana/spl-token';
import { createUpdateAuthorityInstruction } from '@solana/spl-token-metadata';

/**
 * Why a run was refused. The script prints the message; the kind is there so
 * tests (and a caller that wants to count refusals) don't match on text.
 *
 * - `usage`: the command line itself is wrong (no mint, an unknown flag).
 * - `key`: a public key is missing or isn't valid base58.
 * - `number`: a numeric setting is missing its digits, negative, or too large.
 * - `roles`: the role keys would defeat the separation of duties.
 * - `nothing`: the signing key holds no authority on the mint.
 * - `partial`: the handover would leave a god key outside Vetowall.
 */
export type AdoptErrorKind = 'usage' | 'key' | 'number' | 'roles' | 'nothing' | 'partial';

export class AdoptError extends Error {
  kind: AdoptErrorKind;
  constructor(kind: AdoptErrorKind, message: string) {
    super(message);
    this.name = 'AdoptError';
    this.kind = kind;
  }
}

/** The four keys a Vetowall config separates. All four must differ; see `parseRoles`. */
export interface RoleKeys {
  proposer: PublicKey;
  approver: PublicKey;
  guardian: PublicKey;
  attestor: PublicKey;
}

export interface Options {
  mint: PublicKey;
  /** False is a dry run: the script prints the plan and signs nothing. */
  send: boolean;
  /** The operator accepted, with `--partial`, that some authority stays outside Vetowall. */
  partial: boolean;
  roles: RoleKeys;
  /** Timelocks in seconds for Safe, Params, Authority, Max, in that order. */
  delays: [number, number, number, number];
  /** Fast-lane cap per 24 hours, in whole tokens. `capInBaseUnits` scales it by the mint's decimals. */
  dailyCapTokens: bigint;
  /** How old a reserve attestation may be before mints are refused, in seconds. */
  maxAge: number;
  /** Solana CLI keypair file of the current authority holder; undefined means the CLI default. */
  keypairPath: string | undefined;
}

/** Devnet demo timelocks: the same values `seed-devnet.ts` uses, short enough to watch a proposal mature. */
const DEFAULT_DELAYS = '0,120,180,300';
const DEFAULT_DAILY_CAP = '1000000';
/** One day. A reserve attestation older than this stops minting until the attestor signs a new one. */
const DEFAULT_MAX_AGE = '86400';
/**
 * Upper bound for any delay or age we accept, in seconds: ten years. The
 * program stores these as i64 and adds them to the clock, so a value near
 * i64::MAX would overflow there. JavaScript would also have lost integer
 * precision long before (above 2^53). No real policy needs more than years.
 */
const MAX_SECONDS = 10 * 365 * 86400;
const U64_MAX = (1n << 64n) - 1n;
const FLAGS = ['--yes', '--partial'];

/**
 * Parses a whole number of seconds or tokens written in plain decimal digits.
 *
 * We don't use `Number()` or `BigInt()` here. `Number('')` is 0 and
 * `Number(' 12 ')` is 12, so a typo such as `DELAYS=0,,180,300` would quietly
 * become a zero-second timelock, which is the exact failure Vetowall exists to
 * prevent. Only digits pass; a sign, a decimal point, an exponent or
 * whitespace is refused with the setting's name.
 */
function digits(name: string, text: string): bigint {
  if (!/^[0-9]{1,20}$/.test(text)) throw new AdoptError('number', `${name} must be a whole number in plain digits, got "${text}".`);
  return BigInt(text);
}

/** Parses a duration setting and holds it under `MAX_SECONDS`, so the conversion to `number` is exact. */
function seconds(name: string, text: string): number {
  const n = digits(name, text);
  if (n > BigInt(MAX_SECONDS)) throw new AdoptError('number', `${name} is ${n} s, above the ${MAX_SECONDS} s (ten years) we accept.`);
  return Number(n);
}

/**
 * Parses `DELAYS` into the four class timelocks.
 *
 * We check here what the program's `validate_delays` checks onchain: four
 * values that never decrease from Safe to Max. The program would reject a bad
 * set anyway, but only after the operator has signed and paid for a
 * transaction, and with `BadDelays` instead of the position that is wrong.
 */
function parseDelays(text: string): [number, number, number, number] {
  const parts = text.split(',');
  if (parts.length !== 4) throw new AdoptError('number', `DELAYS needs four values (Safe,Params,Authority,Max), got ${parts.length}.`);
  const [safe, params, authority, max] = parts.map((p, i) => seconds(`DELAYS[${i}]`, p)) as [number, number, number, number];
  if (safe > params || params > authority || authority > max) {
    throw new AdoptError('number', `DELAYS must not decrease from Safe to Max, got ${text}.`);
  }
  return [safe, params, authority, max];
}

/** Reads one public key from the environment. A missing or malformed key is an error, never a default. */
function parseKey(name: string, text: string | undefined): PublicKey {
  if (!text) throw new AdoptError('key', `Set ${name} to a public key.`);
  try {
    return new PublicKey(text);
  } catch {
    throw new AdoptError('key', `${name} is not a valid public key: "${text}".`);
  }
}

/**
 * Reads the four role keys and refuses a set that shares a key.
 *
 * The program takes whatever keys `initialize` is given; it doesn't compare
 * them. But each pairing that shares a key removes a control. A proposer that
 * is also the approver has no checker. A guardian that is also a signer vetoes
 * its own proposals. An attestor that is also a signer raises the reserve
 * bound it is then checked against. So one stolen key would again be enough,
 * and the console would still show four roles. We refuse the whole set and
 * name the two roles that collide.
 */
function parseRoles(env: Record<string, string | undefined>): RoleKeys {
  const roles: RoleKeys = {
    proposer: parseKey('PROPOSER', env.PROPOSER),
    approver: parseKey('APPROVER', env.APPROVER),
    guardian: parseKey('GUARDIAN', env.GUARDIAN),
    attestor: parseKey('ATTESTOR', env.ATTESTOR),
  };
  const seen = new Map<string, string>();
  for (const [role, k] of Object.entries(roles) as [string, PublicKey][]) {
    const other = seen.get(k.toBase58());
    if (other) throw new AdoptError('roles', `${other.toUpperCase()} and ${role.toUpperCase()} are the same key. Each role needs its own.`);
    // The all-zero key has no private key, so nobody could ever sign for the role.
    if (k.equals(PublicKey.default)) throw new AdoptError('roles', `${role.toUpperCase()} is the all-zero key, which nobody can sign for.`);
    seen.set(k.toBase58(), role);
  }
  return roles;
}

/**
 * Turns the command line and environment into `Options`, or throws `AdoptError`.
 *
 * `argv` is everything after the script name. We reject unknown flags instead
 * of ignoring them: with `--yse` ignored the operator would get a dry run and
 * might believe the mint is guarded.
 */
export function parseOptions(argv: string[], env: Record<string, string | undefined>): Options {
  const flags = argv.filter((a) => a.startsWith('--'));
  const unknown = flags.find((f) => !FLAGS.includes(f));
  if (unknown) throw new AdoptError('usage', `Unknown flag ${unknown}. Flags: ${FLAGS.join(', ')}.`);
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length !== 1) throw new AdoptError('usage', 'Usage: npm run adopt -- <mint> [--yes] [--partial]');
  return {
    mint: parseKey('<mint>', positional[0]),
    send: flags.includes('--yes'),
    partial: flags.includes('--partial'),
    roles: parseRoles(env),
    delays: parseDelays(env.DELAYS || DEFAULT_DELAYS),
    dailyCapTokens: digits('DAILY_CAP', env.DAILY_CAP || DEFAULT_DAILY_CAP),
    maxAge: seconds('MAX_AGE', env.MAX_AGE || DEFAULT_MAX_AGE),
    keypairPath: env.KEYPAIR || undefined,
  };
}

/**
 * Scales the daily cap from whole tokens to the mint's base units.
 *
 * The program stores the cap as a u64. A cap that doesn't fit would either
 * fail to encode or wrap, so we refuse it here with both numbers in the
 * message. Zero is allowed: it switches the fast lane off, and every mint
 * then waits out the Params timelock.
 */
export function capInBaseUnits(tokens: bigint, decimals: number): bigint {
  // Token-2022 stores decimals in one byte; anything else means we were handed the wrong value.
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new AdoptError('number', `The mint reports ${decimals} decimals.`);
  const cap = tokens * 10n ** BigInt(decimals);
  if (cap > U64_MAX) throw new AdoptError('number', `DAILY_CAP of ${tokens} tokens at ${decimals} decimals doesn't fit in a u64.`);
  return cap;
}

/** One authority slot on a mint, as `readMint` in `token.ts` reports it. A null holder means the authority is unset. */
export interface MintAuthority {
  name: string;
  holder: string | null;
}

/**
 * How each authority `readMint` reports is moved. Metadata update isn't a
 * SetAuthority type: the token-metadata interface has its own instruction, so
 * it is marked `metadata` and the script builds that instruction instead.
 */
const MOVES: Record<string, AuthorityType | 'metadata'> = {
  Mint: AuthorityType.MintTokens,
  Freeze: AuthorityType.FreezeAccount,
  'Permanent delegate': AuthorityType.PermanentDelegate,
  Pause: AuthorityType.PausableConfig,
  'Metadata pointer': AuthorityType.MetadataPointer,
  'Metadata update': 'metadata',
  'Close mint': AuthorityType.CloseMint,
};

/**
 * Extensions whose authorities `readMint` reads (TokenMetadata's is the
 * metadata update authority). Any other extension on the mint may carry an
 * authority we can't see, for example the transfer-fee or transfer-hook
 * authority, so `planHandover` reports it as unhandled.
 */
const COVERED: ExtensionType[] = [
  ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata,
  ExtensionType.PermanentDelegate,
  ExtensionType.PausableConfig,
  ExtensionType.MintCloseAuthority,
];

export interface Plan {
  /** Authorities the signing key holds, with how each is moved. Never empty. */
  handover: { name: string; move: AuthorityType | 'metadata' }[];
  /** Authorities held by some other key. They stay god keys after the handover. */
  foreign: MintAuthority[];
  /** Names of extensions on the mint whose authorities this script doesn't read or move. */
  unhandled: string[];
}

/**
 * Decides what the signing key can hand to Vetowall and what would be left outside.
 *
 * `authorities` and `extensions` are the mint's state as read from chain, and
 * `holder` is the key that will sign the handover.
 *
 * Throws `nothing` when the key holds no authority, because a sealed config
 * with no authority behind it guards nothing. Throws `usage` when `readMint`
 * reports an authority name we have no move for: that means `token.ts` grew a
 * new authority and this table didn't, and guessing a SetAuthority type would
 * move the wrong key.
 */
export function planHandover(authorities: MintAuthority[], extensions: ExtensionType[], holder: PublicKey): Plan {
  const me = holder.toBase58();
  const handover = authorities
    .filter((a) => a.holder === me)
    .map((a) => {
      const move = MOVES[a.name];
      if (move === undefined) throw new AdoptError('usage', `No handover is defined for the "${a.name}" authority.`);
      return { name: a.name, move };
    });
  if (!handover.length) throw new AdoptError('nothing', `${me} holds no authority on this mint.`);
  return {
    handover,
    foreign: authorities.filter((a) => a.holder !== null && a.holder !== me),
    unhandled: extensions.filter((e) => !COVERED.includes(e)).map((e) => ExtensionType[e] ?? `extension ${e}`),
  };
}

/**
 * Builds one instruction per authority in the plan, each moving it from `holder` to the Vetowall PDA.
 *
 * It lives here, not in `scripts/adopt.ts`, because `scripts/squads.ts` hands a
 * mint over the same way and a second copy could drift from the `MOVES` table.
 * The caller sends all of them in one transaction, so the authorities move
 * together or not at all.
 */
export function handoverIxs(plan: Plan, mint: PublicKey, holder: PublicKey, authority: PublicKey): TransactionInstruction[] {
  return plan.handover.map((a) =>
    a.move === 'metadata'
      ? createUpdateAuthorityInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, oldAuthority: holder, newAuthority: authority })
      : createSetAuthorityInstruction(mint, holder, a.move, authority, [], TOKEN_2022_PROGRAM_ID),
  );
}

/**
 * Refuses to send a handover that leaves a god key, unless the operator passed `--partial`.
 *
 * A mint is only as controlled as its weakest authority: with the mint
 * authority on Vetowall and the permanent delegate on a hot key, that key can
 * still seize every balance. The first version of the script printed a warning
 * and carried on, and its last line could then claim the mint was fully
 * guarded. Now the default is to stop, and `--partial` records that the
 * operator saw the list and accepts it.
 */
export function requireComplete(plan: Plan, partial: boolean): void {
  const gaps = [...plan.foreign.map((a) => `${a.name} (held by ${a.holder})`), ...plan.unhandled.map((e) => `${e} extension`)];
  if (gaps.length && !partial) {
    throw new AdoptError('partial', `These would stay outside Vetowall: ${gaps.join('; ')}. Move them first, or pass --partial to accept that.`);
  }
}
