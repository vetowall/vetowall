import assert from "node:assert/strict";
import { test } from "node:test";
import { TOKEN_2022_PROGRAM, decodeTargetIx, mockVaultIdl, type Proposal, type TargetIx } from "../src/decode.ts";
import { explain, template } from "../src/explain.ts";
import {
  DAY, authorityChange, evaluate, mintSize, mintUnbacked, recentRoleChange, ui, vaultRisk, type Ctx,
} from "../src/rules.ts";

const NOW = 1_780_000_000;
const VETOWALL = "G8LSBa3y5XqY5fK4R6NTK84oPru3W3hsNzRwjunLWedr";
const MINT = "So11111111111111111111111111111111111111112";
const M = 10n ** 6n; // 6-decimal stablecoin

const proposal = (o: Partial<Proposal> = {}): Proposal => ({
  config: "cfg", id: 7n, targetProgram: TOKEN_2022_PROGRAM, accounts: [], data: new Uint8Array(),
  class: "Params", queuedAt: NOW, eta: NOW + 2 * DAY, status: "Queued", amount: null, ...o,
});
const ctx = (o: Partial<Ctx> = {}): Ctx => ({
  now: NOW, decimals: 6, mintHistory: [], roleChanges: [], mintMultiple: 10, mintCeilingTokens: 1_000_000_000n, ...o,
});
const mint = (amount: bigint, decimals?: number): TargetIx =>
  ({ program: "token-2022", name: decimals === undefined ? "MintTo" : "MintToChecked", amount, decimals, mint: MINT });
const daily = (tokens: bigint, days = 6) =>
  Array.from({ length: days }, (_, i) => ({ amount: tokens * M, at: NOW - (i + 1) * DAY }));

test("ui formats base units as whole tokens", () => {
  assert.equal(ui(80_000_000n * M, 6), "80,000,000");
  assert.equal(ui(1_500_000n, 6), "1.5");
  assert.equal(ui(5n, 0), "5");
});

test("Resolv-style: 80M unbacked mint against fully-backed supply is vetoed as unbacked", () => {
  // 100M supply, 100M attested reserves, routine 1M/day mints; the attacker mints 80M.
  const c = ctx({ supply: 100_000_000n * M, reserve: { amount: 100_000_000n * M, updatedAt: NOW - 3600 }, mintHistory: daily(1_000_000n) });
  const ix = mint(80_000_000n * M);
  const hit = mintUnbacked(proposal(), ix, c);
  assert.equal(hit?.rule, "mint_unbacked");
  assert.equal(hit?.severity, "critical");
  assert.equal(hit?.facts.unbacked, "80,000,000");
  assert.equal(hit?.facts.headroom, "0");

  const hits = evaluate(proposal(), ix, c, VETOWALL);
  assert.deepEqual(hits.map((h) => h.rule), ["mint_unbacked", "mint_over_average"]);
});

test("$300T fat-finger mint trips the absolute ceiling", () => {
  // Paxos minted 300T PYUSD by mistake. 300T at 6 decimals overflows u64, so this
  // token uses 2 decimals; the ceiling is in whole tokens either way.
  const ix = mint(300_000_000_000_000n * 100n, 2);
  const hit = mintSize(proposal(), ix, ctx({ decimals: 2 }));
  assert.equal(hit?.rule, "mint_over_ceiling");
  assert.equal(hit?.severity, "critical");
  assert.equal(hit?.facts.amount, "300,000,000,000,000");
  assert.equal(hit?.facts.ceiling, "1,000,000,000");
});

test("mint above N x the trailing 7-day average", () => {
  const c = ctx({ mintHistory: daily(1_000_000n) });
  assert.equal(mintSize(proposal(), mint(10_000_000n * M), c), null); // exactly 10x is allowed
  const hit = mintSize(proposal(), mint(10_000_001n * M), c);
  assert.equal(hit?.rule, "mint_over_average");
  assert.equal(hit?.facts.avg_7d, "1,000,000");
  assert.equal(hit?.facts.mints_7d, 6);
});

test("mints older than 7 days don't count toward the average; no history means ceiling only", () => {
  const old = [{ amount: 1n * M, at: NOW - 8 * DAY }];
  assert.equal(mintSize(proposal(), mint(500_000_000n * M), ctx({ mintHistory: old })), null);
  assert.equal(mintSize(proposal(), mint(500_000_000n * M), ctx()), null);
});

test("mint within reserves and average passes every rule", () => {
  const c = ctx({ supply: 100n * M, reserve: { amount: 200n * M, updatedAt: NOW }, mintHistory: daily(50n) });
  assert.deepEqual(evaluate(proposal(), mint(100n * M), c, VETOWALL), []);
  assert.equal(mintUnbacked(proposal(), mint(100n * M + 1n), c)?.rule, "mint_unbacked");
});

test("no Reserve account: the reserve rule abstains", () => {
  assert.equal(mintUnbacked(proposal(), mint(10n ** 18n), ctx({ supply: 0n })), null);
});

test("non-mint instructions are ignored by the mint rules", () => {
  const burn: TargetIx = { program: "token-2022", name: "Burn", amount: 10n ** 18n, mint: MINT };
  assert.equal(mintSize(proposal(), burn, ctx()), null);
  assert.equal(mintUnbacked(proposal(), burn, ctx({ supply: 0n, reserve: { amount: 0n, updatedAt: NOW } })), null);
});

test("SetAuthority and Max-class proposals", () => {
  const set = decodeTargetIx(TOKEN_2022_PROGRAM, Buffer.from([6, 0, 0]), [{ pubkey: MINT, isSigner: false, isWritable: true }]);
  const hit = authorityChange(proposal({ class: "Max" }), set, ctx());
  assert.equal(hit?.rule, "set_authority");
  assert.equal(hit?.facts.authority_type, "MintTokens");
  assert.equal(hit?.facts.new_authority, null);

  const freeze: TargetIx = { program: "token-2022", name: "FreezeAccount", mint: MINT };
  assert.equal(authorityChange(proposal({ class: "Max" }), freeze, ctx())?.rule, "max_class");
  assert.equal(authorityChange(proposal({ class: "Params" }), freeze, ctx()), null);
});

test("mock_vault: collateral mint younger than 7 days", () => {
  const ix: TargetIx = { program: "mock_vault", name: "list_collateral", args: { mint: MINT, price: 1_000_000n, weight_bps: 8000 } };
  assert.equal(vaultRisk(proposal(), ix, ctx({ collateralMintCreatedAt: NOW - 2 * DAY }))?.facts.mint_age_days, 2);
  assert.equal(vaultRisk(proposal(), ix, ctx({ collateralMintCreatedAt: null }))?.rule, "young_collateral");
  assert.equal(vaultRisk(proposal(), ix, ctx({ collateralMintCreatedAt: NOW - 30 * DAY })), null);
});

test("mock_vault: withdraw-limit increase above 5x (the Drift move)", () => {
  const ix = (n: bigint): TargetIx => ({ program: "mock_vault", name: "set_withdraw_limit", args: { withdraw_limit: n } });
  const hit = vaultRisk(proposal({ targetProgram: mockVaultIdl.address }), ix(20_000n), ctx({ currentWithdrawLimit: 1_000n }));
  assert.equal(hit?.rule, "withdraw_limit_jump");
  assert.equal(hit?.facts.multiple, 20);
  assert.equal(vaultRisk(proposal(), ix(5_000n), ctx({ currentWithdrawLimit: 1_000n })), null);
  assert.equal(vaultRisk(proposal(), ix(1n), ctx({ currentWithdrawLimit: 0n }))?.facts.multiple, null);
});

test("any proposal within 7 days of a role change", () => {
  const p = proposal();
  const hit = recentRoleChange(p, mint(1n), ctx({ roleChanges: [{ role: "guardian", at: NOW - 9 * DAY }, { role: "approver", at: NOW - 2 * DAY }] }));
  assert.equal(hit?.facts.role, "approver");
  assert.equal(hit?.facts.hours_after_change, 48);
  assert.equal(recentRoleChange(p, mint(1n), ctx({ roleChanges: [{ role: "proposer", at: NOW - 8 * DAY }] })), null);
  assert.equal(recentRoleChange(p, mint(1n), ctx({ roleChanges: [{ role: "proposer", at: NOW + 60 }] })), null);
});

const register = (disc: number[], cls: string, limit: object | null): TargetIx => ({
  program: "vetowall",
  name: "register",
  args: { target_program: TOKEN_2022_PROGRAM, discriminator: [...disc, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8), disc_len: 1, class: cls, limit },
});

test("a queued register that makes minting Safe or drops the reserve bound is vetoed", () => {
  const p = proposal({ targetProgram: VETOWALL, class: "Max" });
  const bounded = { amount_offset: 1, cap: 1_000_000n * M, window: 86_400n, reserve: "rsv", mint_index: 0 };
  assert.equal(evaluate(p, register([7], "Safe", null), ctx(), VETOWALL)[0].rule, "policy_weakening");
  assert.equal(evaluate(p, register([7], "Params", { ...bounded, reserve: null }), ctx(), VETOWALL)[0].rule, "policy_weakening");
  assert.equal(evaluate(p, register([44, 2], "Safe", null), ctx(), VETOWALL)[0].rule, "policy_weakening");
  assert.equal(evaluate(p, register([6], "Safe", null), ctx(), VETOWALL)[0].rule, "policy_weakening");
  // Raising a cap, or making Pause safe, is ordinary governance.
  assert.deepEqual(evaluate(p, register([7], "Params", bounded), ctx(), VETOWALL), []);
  assert.deepEqual(evaluate(p, register([44, 1], "Safe", null), ctx(), VETOWALL), []);
});

test("evaluate skips guardian rotation and non-queued proposals", () => {
  const c = ctx({ roleChanges: [{ role: "guardian", at: NOW - DAY }] });
  assert.deepEqual(evaluate(proposal({ targetProgram: VETOWALL, class: "Max" }), { program: "vetowall", name: "set_guardian" }, c, VETOWALL), []);
  assert.deepEqual(evaluate(proposal({ status: "Executed", class: "Max" }), mint(1n), c, VETOWALL), []);
  assert.equal(evaluate(proposal(), mint(1n), c, VETOWALL)[0].rule, "recent_role_change");
});

test("template explanation is deterministic and cites the facts", async () => {
  const c = ctx({ supply: 100_000_000n * M, reserve: { amount: 100_000_000n * M, updatedAt: NOW } });
  const hits = evaluate(proposal(), mint(80_000_000n * M), c, VETOWALL);
  const text = template(7n, hits);
  assert.match(text, /^Guardian vetoed proposal #7\. It mints 80,000,000 tokens/);
  assert.match(text, /80,000,000 would be unbacked/);
  assert.equal(template(7n, hits), text);

  delete process.env.ANTHROPIC_API_KEY;
  assert.deepEqual(await explain(7n, hits), { text, by: "template" });
});
