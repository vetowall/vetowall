import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  PAUSABLE_TAG, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, accountDisc, anchorDisc, decodeMint, decodeProposal, decodeReserve,
  decodeTargetIx, mockVaultIdl, vetoData, vetowallIdl, type Meta,
} from "../src/decode.ts";

const key = () => Keypair.generate().publicKey;
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const metas = (n: number): Meta[] => Array.from({ length: n }, () => ({ pubkey: key().toBase58(), isSigner: false, isWritable: true }));

test("decodes a v1 Proposal allocated at max size (trailing zeros ignored)", () => {
  const config = key(), target = key(), m = key();
  const data = Buffer.from([7, ...u64(5n)]);
  const raw = Buffer.concat([
    accountDisc(vetowallIdl, "Proposal"), config.toBuffer(), u64(42n), target.toBuffer(),
    u32(1), m.toBuffer(), Buffer.from([0, 1]),
    u32(data.length), data,
    Buffer.from([1]), i64(1_700_000_000), i64(1_700_000_120), Buffer.from([0]), Buffer.alloc(32),
    Buffer.alloc(500), // unused space up to MAX_ACCOUNTS / MAX_DATA
  ]);
  const p = decodeProposal(raw);
  assert.equal(p.config, config.toBase58());
  assert.equal(p.id, 42n);
  assert.equal(p.targetProgram, target.toBase58());
  assert.deepEqual(p.accounts, [{ pubkey: m.toBase58(), isSigner: false, isWritable: true }]);
  assert.deepEqual([...p.data], [...data]);
  assert.equal(p.class, "Params");
  assert.equal(p.queuedAt, 1_700_000_000);
  assert.equal(p.eta, 1_700_000_120);
  assert.equal(p.status, "Queued");
  assert.equal(p.amount, null); // v2 field, absent from the v1 IDL
});

test("rejects accounts with the wrong discriminator", () => {
  assert.throws(() => decodeProposal(Buffer.alloc(400)), /not a Proposal/);
});

test("decodes a Reserve account from the SPEC layout", () => {
  const mint = key();
  const raw = Buffer.concat([anchorDisc("account", "Reserve"), key().toBuffer(), mint.toBuffer(), key().toBuffer(), u64(100n), i64(10), i64(3600)]);
  assert.deepEqual(decodeReserve(raw), { mint: mint.toBase58(), amount: 100n, updatedAt: 10, maxAge: 3600 });
});

test("reads supply and decimals from the base mint layout", () => {
  const raw = Buffer.alloc(82);
  raw.writeBigUInt64LE(123_456n, 36);
  raw[44] = 6;
  assert.deepEqual(decodeMint(raw), { supply: 123_456n, decimals: 6 });
});

test("veto data is the IDL discriminator plus the 32-byte reason", () => {
  const reason = Buffer.alloc(32, 9);
  assert.deepEqual([...vetoData(reason)], [190, 152, 69, 226, 61, 150, 107, 215, ...reason]);
});

test("decodes SPL Token / Token-2022 instructions", () => {
  const a = metas(3);
  const mintTo = decodeTargetIx(TOKEN_2022_PROGRAM, Buffer.from([7, ...u64(80_000_000_000_000n)]), a);
  assert.deepEqual(mintTo, { program: "token-2022", name: "MintTo", amount: 80_000_000_000_000n, mint: a[0].pubkey });

  const checked = decodeTargetIx(TOKEN_PROGRAM, Buffer.from([14, ...u64(5n), 6]), a);
  assert.deepEqual(checked, { program: "spl-token", name: "MintToChecked", amount: 5n, decimals: 6, mint: a[0].pubkey });

  assert.deepEqual(decodeTargetIx(TOKEN_2022_PROGRAM, Buffer.from([8, ...u64(9n)]), a),
    { program: "token-2022", name: "Burn", amount: 9n, mint: a[1].pubkey });
  assert.deepEqual(decodeTargetIx(TOKEN_2022_PROGRAM, Buffer.from([15, ...u64(9n), 2]), a),
    { program: "token-2022", name: "BurnChecked", amount: 9n, decimals: 2, mint: a[1].pubkey });
  assert.equal(decodeTargetIx(TOKEN_2022_PROGRAM, Buffer.from([10]), a).name, "FreezeAccount");
  assert.equal(decodeTargetIx(TOKEN_2022_PROGRAM, Buffer.from([11]), a).mint, a[1].pubkey);

  const to = key();
  assert.deepEqual(decodeTargetIx(TOKEN_2022_PROGRAM, Buffer.from([6, 0, 1, ...to.toBuffer()]), a),
    { program: "token-2022", name: "SetAuthority", authorityType: "MintTokens", newAuthority: to.toBase58(), mint: a[0].pubkey });
  assert.equal(decodeTargetIx(TOKEN_2022_PROGRAM, Buffer.from([6, 8, 0]), a).authorityType, "PermanentDelegate");
  assert.equal(decodeTargetIx(TOKEN_2022_PROGRAM, Buffer.from([6, 8, 0]), a).newAuthority, null);

  assert.equal(decodeTargetIx(TOKEN_2022_PROGRAM, Buffer.from([PAUSABLE_TAG, 1]), a).name, "Pausable.Pause");
  assert.equal(decodeTargetIx(TOKEN_2022_PROGRAM, Buffer.from([PAUSABLE_TAG, 2]), a).name, "Pausable.Resume");
  assert.equal(decodeTargetIx(TOKEN_2022_PROGRAM, Buffer.from([3, ...u64(1n)]), a).name, "Tag3");
  // Truncated MintTo: no amount rather than a crash.
  assert.equal(decodeTargetIx(TOKEN_PROGRAM, Buffer.from([7, 1, 2]), a).amount, undefined);
});

test("decodes mock_vault instructions from its IDL", () => {
  const disc = (n: string) => Buffer.from(mockVaultIdl.instructions.find((i) => i.name === n)!.discriminator);
  const a = metas(2);
  const mint = key();
  const price = Buffer.alloc(2); price.writeUInt16LE(5000);
  const list = decodeTargetIx(mockVaultIdl.address, Buffer.concat([disc("list_collateral"), mint.toBuffer(), u64(1_000_000n), price]), a);
  assert.equal(list.name, "list_collateral");
  assert.deepEqual(list.args, { mint: mint.toBase58(), price: 1_000_000n, weight_bps: 5000 });
  assert.deepEqual(list.named, { vault: a[0].pubkey, admin: a[1].pubkey });

  const lim = decodeTargetIx(mockVaultIdl.address, Buffer.concat([disc("set_withdraw_limit"), u64(20n)]), a);
  assert.deepEqual(lim.args, { withdraw_limit: 20n });

  assert.equal(decodeTargetIx(mockVaultIdl.address, Buffer.alloc(8), a).name, "unknown");
  assert.equal(decodeTargetIx(key().toBase58(), Buffer.from([7]), a).program, "unknown");
});
