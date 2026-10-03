import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AuthorityType, ExtensionType } from '@solana/spl-token';
import { AdoptError, capInBaseUnits, parseOptions, planHandover, requireComplete } from './adopt.ts';

const key = () => Keypair.generate().publicKey.toBase58();
const MINT = key();
const env = () => ({ PROPOSER: key(), APPROVER: key(), GUARDIAN: key(), ATTESTOR: key() });
/** Asserts the call is refused for the named reason, so a refusal for some other reason fails the test. */
const refuses = (kind: AdoptError['kind'], fn: () => unknown) =>
  assert.throws(fn, (e) => e instanceof AdoptError && e.kind === kind, `expected a "${kind}" refusal`);

test('defaults: a dry run with the devnet demo delays', () => {
  const o = parseOptions([MINT], env());
  assert.equal(o.mint.toBase58(), MINT);
  assert.equal(o.send, false);
  assert.equal(o.partial, false);
  assert.deepEqual(o.delays, [0, 120, 180, 300]);
  assert.equal(o.dailyCapTokens, 1_000_000n);
  assert.equal(o.maxAge, 86400);
  assert.equal(o.keypairPath, undefined);
});

test('--yes, --partial and every setting are read', () => {
  const o = parseOptions(['--yes', MINT, '--partial'], { ...env(), DELAYS: '0,172800,259200,604800', DAILY_CAP: '0', MAX_AGE: '3600', KEYPAIR: '/k.json' });
  assert.equal(o.send, true);
  assert.equal(o.partial, true);
  assert.deepEqual(o.delays, [0, 172800, 259200, 604800]);
  assert.equal(o.dailyCapTokens, 0n);
  assert.equal(o.maxAge, 3600);
  assert.equal(o.keypairPath, '/k.json');
});

test('the command line is refused when it is not exactly one mint plus known flags', () => {
  refuses('usage', () => parseOptions([], env()));
  refuses('usage', () => parseOptions([MINT, MINT], env()));
  refuses('usage', () => parseOptions([MINT, '--yse'], env()));
  refuses('key', () => parseOptions(['not-a-key'], env()));
});

test('a missing or malformed role key is refused', () => {
  for (const role of ['PROPOSER', 'APPROVER', 'GUARDIAN', 'ATTESTOR']) {
    refuses('key', () => parseOptions([MINT], { ...env(), [role]: undefined }));
    refuses('key', () => parseOptions([MINT], { ...env(), [role]: 'xyz' }));
  }
});

test('roles that share a key, or use the all-zero key, are refused', () => {
  const e = env();
  refuses('roles', () => parseOptions([MINT], { ...e, APPROVER: e.PROPOSER }));
  refuses('roles', () => parseOptions([MINT], { ...e, GUARDIAN: e.APPROVER }));
  refuses('roles', () => parseOptions([MINT], { ...e, ATTESTOR: e.PROPOSER }));
  refuses('roles', () => parseOptions([MINT], { ...e, GUARDIAN: PublicKey.default.toBase58() }));
});

test('a delay is never filled in: empty, signed, fractional and oversized values are refused', () => {
  for (const DELAYS of ['0,,180,300', '0,120,180', '0,120,180,300,400', '0,-1,180,300', '0,1.5,180,300', '0,1e3,2000,3000', ' 0,120,180,300', '0,120,180,999999999999']) {
    refuses('number', () => parseOptions([MINT], { ...env(), DELAYS }));
  }
});

test('delays that decrease from Safe to Max are refused, as the program would', () => {
  refuses('number', () => parseOptions([MINT], { ...env(), DELAYS: '0,300,180,300' }));
  refuses('number', () => parseOptions([MINT], { ...env(), DELAYS: '10,5,180,300' }));
  assert.deepEqual(parseOptions([MINT], { ...env(), DELAYS: '5,5,5,5' }).delays, [5, 5, 5, 5]);
});

test('a malformed cap or attestation age is refused', () => {
  refuses('number', () => parseOptions([MINT], { ...env(), DAILY_CAP: '-5' }));
  refuses('number', () => parseOptions([MINT], { ...env(), DAILY_CAP: '1_000' }));
  refuses('number', () => parseOptions([MINT], { ...env(), MAX_AGE: 'day' }));
});

test('the cap is scaled by decimals and must fit in a u64', () => {
  assert.equal(capInBaseUnits(1_000_000n, 6), 1_000_000_000_000n);
  assert.equal(capInBaseUnits(0n, 9), 0n);
  assert.equal(capInBaseUnits(18_446_744_073_709n, 6), 18_446_744_073_709_000_000n);
  refuses('number', () => capInBaseUnits(18_446_744_073_710n, 6));
  refuses('number', () => capInBaseUnits(1n, 256));
  refuses('number', () => capInBaseUnits(1n, -1));
});

test('the plan hands over what the key holds and reports the rest', () => {
  const me = Keypair.generate().publicKey;
  const other = key();
  const plan = planHandover(
    [
      { name: 'Mint', holder: me.toBase58() },
      { name: 'Freeze', holder: other },
      { name: 'Permanent delegate', holder: null },
      { name: 'Metadata update', holder: me.toBase58() },
    ],
    [ExtensionType.PermanentDelegate, ExtensionType.TokenMetadata, ExtensionType.TransferFeeConfig],
    me,
  );
  assert.deepEqual(plan.handover, [
    { name: 'Mint', move: AuthorityType.MintTokens },
    { name: 'Metadata update', move: 'metadata' },
  ]);
  assert.deepEqual(plan.foreign, [{ name: 'Freeze', holder: other }]);
  assert.deepEqual(plan.unhandled, ['TransferFeeConfig']);
});

test('a key that holds nothing, or an authority with no defined move, is refused', () => {
  const me = Keypair.generate().publicKey;
  refuses('nothing', () => planHandover([{ name: 'Mint', holder: key() }, { name: 'Freeze', holder: null }], [], me));
  refuses('usage', () => planHandover([{ name: 'Transfer hook', holder: me.toBase58() }], [], me));
});

test('a handover that leaves a god key needs --partial', () => {
  const me = Keypair.generate().publicKey;
  const mine = [{ name: 'Mint', holder: me.toBase58() }];
  const complete = planHandover(mine, [ExtensionType.PausableConfig], me);
  requireComplete(complete, false);

  const foreign = planHandover([...mine, { name: 'Freeze', holder: key() }], [], me);
  refuses('partial', () => requireComplete(foreign, false));
  requireComplete(foreign, true);

  const unhandled = planHandover(mine, [ExtensionType.TransferHook], me);
  refuses('partial', () => requireComplete(unhandled, false));
  requireComplete(unhandled, true);
});
