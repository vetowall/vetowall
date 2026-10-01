import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BorshCoder, EventParser, convertIdlToCamelCase, type Idl } from '@anchor-lang/core';
import { Keypair, PublicKey } from '@solana/web3.js';
import { PROGRAM, TOKEN_2022_ID, recordToAction, refusedAction, type DecodedRecord } from './records.ts';
import { reportRows } from './report.ts';
import { demoSnapshot } from './demo.ts';

const idl = JSON.parse(readFileSync(new URL('./idl/vetowall.json', import.meta.url), 'utf8')) as Idl;
const parser = new EventParser(new PublicKey(PROGRAM), new BorshCoder(convertIdlToCamelCase(idl)));
const key = () => Keypair.generate().publicKey;
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const some = (b: Buffer) => Buffer.concat([Buffer.from([1]), b]);
const none = Buffer.from([0]);

/** The log lines `execute_now` leaves for a 1,000,000-token mint (6 decimals). */
function fastLaneLogs(proposer: PublicKey, approver: PublicKey, ts: number) {
  const event = Buffer.concat([
    Buffer.from(idl.events!.find((e) => e.name === 'ChangeRecord')!.discriminator),
    Buffer.from([2]), // RecordKind::ExecutedNow
    key().toBuffer(), // config
    none, // proposal_id
    new PublicKey(TOKEN_2022_ID).toBuffer(),
    Buffer.from([7, 0, 0, 0, 0, 0, 0, 0]), // MintTo
    some(u64(1_000_000_000_000n)),
    some(Buffer.from([1])), // ActionClass::Params
    proposer.toBuffer(),
    some(approver.toBuffer()),
    none, // subject
    Buffer.alloc(32), // reason
    u64(BigInt(ts)),
  ]);
  return [`Program ${PROGRAM} invoke [1]`, `Program data: ${event.toString('base64')}`, `Program ${PROGRAM} success`];
}

test('a fast-lane ChangeRecord log line becomes a complete report row', () => {
  const [proposer, approver, mint, dest] = [key(), key(), key(), key()];
  const ts = 1_790_000_000;
  const [event] = [...parser.parseLogs(fastLaneLogs(proposer, approver, ts))];
  assert.equal(event.name, 'changeRecord');

  const routed = { accounts: [mint, dest, key()].map((pubkey) => ({ pubkey })), data: [7, ...u64(1_000_000_000_000n)] };
  const action = recordToAction(event.data as DecodedRecord, 'SIG1234567', 6, routed)!;
  const [row] = reportRows({ ...demoSnapshot, actions: [action] });
  const at = new Date(ts * 1000).toISOString();
  assert.deepEqual(
    {
      change_id: row.change_id, requested_utc: row.requested_utc, executed_utc: row.executed_utc, action: row.action,
      subject: row.subject, amount: row.amount, path: row.path, risk_class: row.risk_class, maker: row.maker,
      checker: row.checker, waiting_period_hours: row.waiting_period_hours, outcome: row.outcome,
      reserve_check: row.reserve_check, evidence: row.evidence,
    },
    {
      change_id: 'fast lane:SIG12345', requested_utc: at, executed_utc: at, action: 'Mint', subject: dest.toBase58(),
      amount: '1000000 USDV', path: 'fast lane', risk_class: 'Params', maker: proposer.toBase58(),
      checker: approver.toBase58(), waiting_period_hours: '0', outcome: 'executed',
      reserve_check: 'Within attested reserves', evidence: 'https://explorer.solana.com/tx/SIG1234567?cluster=devnet',
    },
  );
});

test('proposal records defer to the Proposal account; setup records name the admin key', () => {
  const base = {
    config: key(), proposalId: null, targetProgram: PublicKey.default, discriminator: [0, 0, 0, 0, 0, 0, 0, 0],
    amount: null, class: null, actor: key(), approver: null, subject: null, reason: Array(32).fill(0), timestamp: 1,
  };
  assert.equal(recordToAction({ ...base, kind: { executed: {} }, proposalId: 3 }, 's', 6), null);
  const sealed = recordToAction({ ...base, kind: { sealed: {} } }, 's', 6)!;
  const [row] = reportRows({ ...demoSnapshot, actions: [{ ...sealed, seq: 8 }] });
  assert.equal(row.change_id, 'governance:s/8'); // unique among the records of one setup tx
  assert.equal(row.action, 'Config sealed');
  assert.equal(row.risk_class, 'n/a');
  assert.match(row.key_custody, /^Admin key \w+ \(setup, before seal\)$/);
});

test('a refused fast-lane transaction becomes a refused row with the program error', () => {
  const [mint, dest, proposer] = [key(), key(), key()];
  const a = refusedAction(
    { targetProgram: new PublicKey(TOKEN_2022_ID), accounts: [mint, dest].map((pubkey) => ({ pubkey })), data: [7, ...u64(80_000_000_000_000n)] },
    { proposer: proposer.toBase58() },
    'OverReserves',
    1_790_000_100,
    'FAILSIG',
    6,
  );
  const [row] = reportRows({ ...demoSnapshot, actions: [a] });
  assert.equal(row.outcome, 'refused');
  assert.equal(row.amount, '80000000 USDV');
  assert.equal(row.reserve_check, 'Refused by program');
  assert.equal(a.note, 'Refused onchain (OverReserves)');
});
