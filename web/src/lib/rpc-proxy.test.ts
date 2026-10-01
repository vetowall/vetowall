import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BODY_BYTES, RATE, handleRpc } from './rpc-proxy.ts';

const UPSTREAM = 'https://rpc.example/?api-key=SECRET';
let n = 0;
const ip = () => `10.0.0.${++n}`;

function post(body: unknown, from = ip()) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('http://localhost/api/rpc', { method: 'POST', body: text, headers: { 'x-forwarded-for': `${from}, 1.1.1.1` } });
}

/** A fake upstream that records what it was sent. */
function upstream() {
  const seen: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push(`${url} ${init.body}`);
    return Response.json({ jsonrpc: '2.0', id: 1, result: 'ok' });
  }) as typeof fetch;
  return { seen, f };
}

const call = (method: string, id = 1) => ({ jsonrpc: '2.0', id, method, params: [] });

test('allowed methods are forwarded, single and batched', async () => {
  const u = upstream();
  const one = await handleRpc(post(call('getLatestBlockhash')), { upstream: UPSTREAM, fetch: u.f });
  assert.equal(one.status, 200);
  assert.deepEqual(await one.json(), { jsonrpc: '2.0', id: 1, result: 'ok' });
  const batch = await handleRpc(post([call('getBalance', 1), call('sendTransaction', 2)]), { upstream: UPSTREAM, fetch: u.f });
  assert.equal(batch.status, 200);
  assert.equal(u.seen.length, 2);
  assert.ok(u.seen.every((s) => s.startsWith(UPSTREAM)));
});

test('anything off the allowlist is refused without reaching upstream', async () => {
  const u = upstream();
  for (const body of [
    call('getProgramAccounts'),
    call('requestAirdrop'),
    [call('getBalance'), call('getSignaturesForAddress')],
    { jsonrpc: '2.0', id: 1 },
    [],
    'not json',
  ]) {
    const res = await handleRpc(post(body), { upstream: UPSTREAM, fetch: u.f });
    assert.ok(res.status === 403 || res.status === 400, `${JSON.stringify(body)} -> ${res.status}`);
    assert.ok(!(await res.text()).includes('SECRET'));
  }
  assert.equal(u.seen.length, 0);
});

test('oversized bodies are refused', async () => {
  const u = upstream();
  const big = { ...call('sendTransaction'), params: ['A'.repeat(MAX_BODY_BYTES)] };
  const res = await handleRpc(post(big), { upstream: UPSTREAM, fetch: u.f });
  assert.equal(res.status, 413);
  assert.equal(u.seen.length, 0);
});

test('each IP gets RATE.calls per window, batches count per call, and the window resets', async () => {
  const u = upstream();
  const me = ip();
  const opts = (now: number) => ({ upstream: UPSTREAM, fetch: u.f, now });
  const batch = Array.from({ length: 10 }, (_, i) => call('getBalance', i));
  for (let i = 0; i < RATE.calls / 10; i++) assert.equal((await handleRpc(post(batch, me), opts(1000))).status, 200);
  const over = await handleRpc(post(call('getBalance'), me), opts(1000));
  assert.equal(over.status, 429);
  assert.ok(over.headers.get('retry-after'));
  // Another IP is unaffected; the same IP recovers in the next window.
  assert.equal((await handleRpc(post(call('getBalance')), opts(1000))).status, 200);
  assert.equal((await handleRpc(post(call('getBalance'), me), opts(1000 + RATE.windowMs))).status, 200);
});

test('an upstream failure does not leak the upstream URL', async () => {
  const f = (async () => {
    throw new Error(`connect ECONNREFUSED ${UPSTREAM}`);
  }) as typeof fetch;
  const res = await handleRpc(post(call('getBalance')), { upstream: UPSTREAM, fetch: f });
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes('SECRET'));
});
