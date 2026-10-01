// The browser's only way to Solana: a JSON-RPC proxy that keeps the keyed RPC
// URL (SOLANA_RPC_URL) on the server. It forwards an allowlist of methods,
// caps the body size and rate-limits per IP. Plain Request/Response, so it's
// tested under node:test without Next.

/** Reads the console makes from the browser, plus what sending a transaction needs. */
export const ALLOWED_METHODS = new Set([
  'getAccountInfo', // config and proposal reads before queue/execute, mint and program checks
  'getMultipleAccounts',
  'getTransaction', // logs of a failed send, to name the program error
  'sendTransaction',
  'simulateTransaction',
  'getLatestBlockhash',
  'getSignatureStatuses', // confirmation by polling (no WebSocket through the proxy)
  'getFeeForMessage',
  'getMinimumBalanceForRentExemption',
  'getBalance',
]);

/** A signed transaction is at most 1232 bytes (~1.7 kB base64); this leaves room for a small batch. */
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_BATCH = 10;
/** Calls per IP per window; a batch counts each call. */
export const RATE = { calls: 120, windowMs: 60_000 };

// ponytail: per-instance memory, so the limit is per serverless instance; move to a shared store (e.g. Upstash) if abuse shows up.
const hits = new Map<string, { start: number; n: number }>();

/** Charges `cost` calls to `ip`; false once the window's budget is spent. */
export function rateLimit(ip: string, cost: number, now = Date.now()): boolean {
  if (hits.size > 10_000) for (const [k, h] of hits) if (now - h.start >= RATE.windowMs) hits.delete(k);
  let h = hits.get(ip);
  if (!h || now - h.start >= RATE.windowMs) hits.set(ip, (h = { start: now, n: 0 }));
  h.n += cost;
  return h.n <= RATE.calls;
}

export const clientIp = (req: Request) =>
  req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';

const fail = (status: number, message: string, id: unknown = null, headers?: HeadersInit) =>
  Response.json({ jsonrpc: '2.0', id, error: { code: status === 429 ? -32005 : -32600, message } }, { status, headers });

interface Options {
  upstream: string;
  fetch?: typeof fetch;
  now?: number;
}

export async function handleRpc(req: Request, { upstream, fetch: f = fetch, now = Date.now() }: Options): Promise<Response> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return fail(413, 'Request body too large');
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return fail(413, 'Request body too large');

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, 'Body is not JSON');
  }
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > MAX_BATCH) return fail(400, `Send 1 to ${MAX_BATCH} calls per request`);
  for (const c of calls) {
    const method = (c as { method?: unknown })?.method;
    if (typeof method !== 'string' || !ALLOWED_METHODS.has(method)) {
      return fail(403, `Method not allowed: ${String(method).slice(0, 64)}`, (c as { id?: unknown })?.id ?? null);
    }
  }
  if (!rateLimit(clientIp(req), calls.length, now)) {
    return fail(429, 'Too many requests', null, { 'Retry-After': String(Math.ceil(RATE.windowMs / 1000)) });
  }

  try {
    const res = await f(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, cache: 'no-store' });
    return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch {
    // Never echo the upstream error: it can carry the keyed URL.
    return fail(502, 'Upstream RPC unavailable');
  }
}
