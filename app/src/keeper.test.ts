import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { KeeperError, decide, parseKeypair } from './keeper.ts';

const refuses = (kind: KeeperError['kind'], fn: () => unknown) =>
  assert.throws(fn, (e) => e instanceof KeeperError && e.kind === kind, `expected a "${kind}" refusal`);
const ME = 'Attestor1111111111111111111111111111111111';
const DAY = 86400;
const reserve = (updatedAt: number, maxAge = DAY) => ({ attestor: ME, updatedAt, maxAge });

test('a CLI keypair parses back to the same key', () => {
  const kp = Keypair.generate();
  const bytes = parseKeypair(JSON.stringify([...kp.secretKey]));
  assert.equal(Keypair.fromSecretKey(bytes).publicKey.toBase58(), kp.publicKey.toBase58());
});

test('a malformed keypair is refused without echoing it', () => {
  const secret = '[12, 34, 56, oops 78]';
  for (const text of [undefined, '', secret, '{"a":1}', '[1,2,3]', JSON.stringify(Array(64).fill(256)), JSON.stringify(Array(64).fill(1.5)), JSON.stringify(Array(65).fill(1))]) {
    refuses('key', () => parseKeypair(text));
  }
  try {
    parseKeypair(secret);
  } catch (e) {
    assert.ok(!/12|34|56|78|oops/.test((e as Error).message.replace('64', '').replace('255', '')), 'the message must not quote the secret');
  }
});

test('fresh below half the max age, refreshed from half onward', () => {
  const now = 1_000_000;
  assert.deepEqual(decide(reserve(now), ME, now), { attest: false, age: 0 });
  assert.deepEqual(decide(reserve(now - DAY / 2 + 1), ME, now), { attest: false, age: DAY / 2 - 1 });
  assert.deepEqual(decide(reserve(now - DAY / 2), ME, now), { attest: true, age: DAY / 2 });
  assert.deepEqual(decide(reserve(now - 3 * DAY), ME, now), { attest: true, age: 3 * DAY });
});

test('an attestation stamped ahead of our clock counts as fresh', () => {
  assert.deepEqual(decide(reserve(1_000_030), ME, 1_000_000), { attest: false, age: 0 });
});

test('the wrong key and an unusable reserve are refused', () => {
  refuses('not-attestor', () => decide(reserve(0), 'SomeoneElse', 100));
  refuses('state', () => decide(reserve(0, 0), ME, 100));
  refuses('state', () => decide(reserve(0, -5), ME, 100));
  refuses('state', () => decide(reserve(Number.NaN), ME, 100));
});
