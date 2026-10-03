// Decisions for `scripts/attest.ts`, the scheduled job that keeps the devnet
// demo issuer's reserve attestation fresh. Pure: the reserve state, the
// signing key and the clock come in, and a decision or a `KeeperError` comes
// out. The script does the RPC calls and the signing.
//
// What this keeper is not: an auditor. On devnet there is no bank balance to
// read, so it re-affirms the figure that is already onchain. It exists because
// Vetowall refuses every mint once the attestation is older than its max age,
// and without a refresh the public demo stops minting a day after seeding.

/**
 * Why a run stopped without attesting.
 *
 * - `key`: the keypair we were given can't be parsed.
 * - `not-attestor`: the key isn't this reserve's attestor, so the program would reject it.
 * - `state`: the reserve account holds a value we can't reason about.
 */
export type KeeperErrorKind = 'key' | 'not-attestor' | 'state';

export class KeeperError extends Error {
  kind: KeeperErrorKind;
  constructor(kind: KeeperErrorKind, message: string) {
    super(message);
    this.name = 'KeeperError';
    this.kind = kind;
  }
}

/**
 * Parses a Solana CLI keypair (a JSON array of 64 byte values) from text.
 *
 * The text is a secret, usually a CI secret, so no part of it may reach an
 * error message: a JSON parse error quotes the text around the bad character,
 * which is why we catch it and say only what shape we expected. We also check
 * the shape ourselves instead of handing a wrong-length array to the keypair
 * constructor, whose error would be about curve points and not about the
 * secret being pasted wrongly.
 */
export function parseKeypair(text: string | undefined): Uint8Array {
  const bad = new KeeperError('key', 'ATTESTOR_KEYPAIR must be a Solana CLI keypair: a JSON array of 64 numbers from 0 to 255.');
  if (!text) throw bad;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw bad;
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw bad;
  return Uint8Array.from(parsed as number[]);
}

/** What the keeper reads from the Reserve account. Addresses are base58; times are unix seconds. */
export interface KeeperReserve {
  attestor: string;
  updatedAt: number;
  maxAge: number;
}

export interface Decision {
  /** True when the attestation should be refreshed now. */
  attest: boolean;
  /** Age of the current attestation in seconds, never negative. */
  age: number;
}

/**
 * Decides whether to refresh the attestation.
 *
 * We refresh once the attestation has used half of its max age. The job runs
 * every six hours and GitHub can start a scheduled run late, so with the
 * demo's 24-hour max age the attestation is renewed at 12 to 18 hours old and
 * never gets near 24. Refreshing on every run would also work, but each
 * attestation is a change record the console lists and has to fetch, so we
 * write two a day instead of four.
 *
 * A reserve whose `updatedAt` is ahead of our clock (the cluster's clock and
 * the runner's differ by seconds) counts as age zero, which is fresh.
 */
export function decide(reserve: KeeperReserve, signer: string, now: number): Decision {
  if (reserve.attestor !== signer) {
    throw new KeeperError('not-attestor', `The reserve's attestor is ${reserve.attestor}, but the keypair is ${signer}.`);
  }
  // A max age of zero or less makes every attestation stale the moment it lands; refreshing can't fix that.
  if (!Number.isSafeInteger(reserve.maxAge) || reserve.maxAge <= 0 || !Number.isSafeInteger(reserve.updatedAt)) {
    throw new KeeperError('state', `The reserve has max age ${reserve.maxAge} s and was updated at ${reserve.updatedAt}; neither can be kept fresh.`);
  }
  const age = Math.max(0, now - reserve.updatedAt);
  return { attest: age * 2 >= reserve.maxAge, age };
}
