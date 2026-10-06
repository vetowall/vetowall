// Server side: the live snapshot every visitor shares. Read with the keyed
// SOLANA_RPC_URL (never sent to the browser) and cached for ~15s, so one
// RPC crawl of the transaction history serves everyone.
import { unstable_cache } from 'next/cache';
import { Connection, PublicKey } from '@solana/web3.js';
import { demoSnapshot } from './demo.ts';
import type { Snapshot } from './model.ts';
import { isDeployed, loadSnapshot } from './vetowall';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
/** The live devnet demo issuer (vUSD). */
export const DEFAULT_CONFIG = process.env.NEXT_PUBLIC_VETOWALL_CONFIG || 'BQodWY1t1CVVJHpGdR9UnDg3wY3gyTsBDne5y2hSfTgp';
const conn = new Connection(RPC_URL, 'confirmed');

export interface Payload {
  snap: Snapshot;
  /** False when the program itself isn't reachable, so actions are turned off. */
  programUp: boolean;
  /** Server time the snapshot was read, unix seconds. */
  at: number;
}

/** Errors can quote the RPC URL; never let the key reach a log line. */
const scrub = (e: unknown) => String((e as Error)?.message ?? e).split(RPC_URL).join('[SOLANA_RPC_URL]').slice(0, 200);

async function load(config: string, mint: string | null): Promise<Payload> {
  const snap = await loadSnapshot(conn, new PublicKey(config), mint ? new PublicKey(mint) : undefined);
  // Throwing keeps a failure out of the cache; the caller falls back to sample data.
  if (!snap) throw new Error(`config ${config} not found`);
  return { snap, programUp: true, at: Math.floor(Date.now() / 1000) };
}

/** The shared demo issuer: one read every ~15s serves every visitor. */
const shared = unstable_cache(load, ['snapshot-v1'], { revalidate: 15 });

const timeout = (ms: number) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms));

/**
 * A token launched from one browser is read uncached, so its owner sees their
 * own transactions at once (the route rate-limits these per IP).
 */
export async function getSnapshot(config = DEFAULT_CONFIG, mint?: string): Promise<Payload> {
  try {
    const cached = config === DEFAULT_CONFIG && !mint;
    const payload = await Promise.race([cached ? shared(config, null) : load(config, mint ?? null), timeout(25_000)]);
    // The cache serves its old entry once while it refreshes, however old. After an idle hour that would
    // show stale supply and reserves as live, so anything older than a minute is read again.
    if (cached && Date.now() / 1000 - payload.at > 60) return await Promise.race([load(config, null), timeout(25_000)]);
    return payload;
  } catch (e) {
    console.warn('Live snapshot unavailable, serving sample data:', scrub(e));
    const programUp = await Promise.race([isDeployed(conn), timeout(5_000)]).catch(() => false);
    return { snap: demoSnapshot(), programUp, at: Math.floor(Date.now() / 1000) };
  }
}
