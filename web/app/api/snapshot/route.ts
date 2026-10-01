import { PublicKey } from '@solana/web3.js';
import { clientIp, rateLimit } from '@/src/lib/rpc-proxy';
import { getSnapshot } from '@/src/lib/snapshot';

export const dynamic = 'force-dynamic';

const key = (v: string | null) => {
  if (!v) return undefined;
  try {
    return new PublicKey(v).toBase58();
  } catch {
    return null;
  }
};

/** The shared live snapshot (or a token launched from this browser, via ?config=&mint=). */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const config = key(q.get('config'));
  const mint = key(q.get('mint'));
  if (config === null || mint === null) return Response.json({ error: 'config and mint must be base58 addresses' }, { status: 400 });
  // A custom config costs an uncached history crawl; the default one is served from cache.
  if (config && !rateLimit(`snapshot:${clientIp(req)}`, 10)) return Response.json({ error: 'Too many requests' }, { status: 429 });
  return Response.json(await getSnapshot(config, mint), {
    headers: { 'cache-control': config ? 'private, no-store' : 'public, s-maxage=15, stale-while-revalidate=30' },
  });
}
