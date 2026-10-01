// Vetowall guardian: watch queued proposals, run the rules, veto on a hit,
// log every decision, serve the log.
//
//   node src/main.ts [--dry-run]

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  accountDisc, decodeAccount, decodeConfig, decodeMint, decodeProposal, decodeReserve, decodeTargetIx, ixDisc,
  mockVaultIdl, vetoData, vetowallIdl, type Proposal,
} from "./decode.ts";
import { explain } from "./explain.ts";
import { evaluate, type Ctx } from "./rules.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`${k} is required (see .env.example)`);
  return v;
};

const DRY_RUN = process.argv.includes("--dry-run");
const RPC_URL = env("RPC_URL", "https://api.devnet.solana.com");
const PROGRAM_ID = new PublicKey(env("PROGRAM_ID", vetowallIdl.address));
const CONFIG = new PublicKey(env("CONFIG"));
const LOG = env("GUARDIAN_LOG", "./decisions.jsonl");
const PORT = Number(env("PORT", "8787"));
const POLL_MS = Number(env("POLL_MS", "15000"));
const MINT_MULTIPLE = Number(env("MINT_MULTIPLE", "10"));
const MINT_CEILING_TOKENS = BigInt(env("MINT_CEILING_TOKENS", "1000000000"));

const guardian: Keypair | null = DRY_RUN && !process.env.GUARDIAN_KEYPAIR
  ? null
  : Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env("GUARDIAN_KEYPAIR"), "utf8"))));

const conn = new Connection(RPC_URL, { commitment: "confirmed", wsEndpoint: process.env.WS_URL || undefined });

// ---------------------------------------------------------------- decision log (append-only)

type Decision = {
  ts: string; proposal: string; id: number; rule: string; severity: string;
  explanation: string; reason_hash: string; veto_tx: string | null;
};
const decisions: Decision[] = existsSync(LOG)
  ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).reverse()
  : [];
// A real veto is final. A dry-run record only counts as handled in dry-run mode.
const handled = new Set(decisions.filter((d) => d.veto_tx || DRY_RUN).map((d) => d.proposal));

function record(d: Decision) {
  appendFileSync(LOG, JSON.stringify(d) + "\n");
  decisions.unshift(d);
}

// ---------------------------------------------------------------- chain state

const proposals = new Map<string, Proposal>();
const roleChanges: { role: string; at: number }[] = [];
let lastConfig: { proposer: string; approver: string | null; guardian: string } | null = null;
let lastPoll = 0;

const ROLE_SETTERS = ["proposer", "approver", "guardian"].map((role) => ({ role, disc: ixDisc(vetowallIdl, `set_${role}`) }));

/** Role changes executed through the timelock, timed at their eta (they can't run earlier). */
function governanceChanges() {
  const out: { role: string; at: number }[] = [];
  for (const p of proposals.values()) {
    if (p.status !== "Executed" || p.targetProgram !== PROGRAM_ID.toBase58()) continue;
    const head = Buffer.from(p.data.subarray(0, 8));
    const hit = ROLE_SETTERS.find((s) => head.equals(s.disc));
    if (hit) out.push({ role: hit.role, at: p.eta });
  }
  return out;
}

// ponytail: a role change made directly by the admin before `seal` is only seen if
// it happens while the guardian runs; scan the Config's transaction history if that matters.
async function watchConfig() {
  const info = await conn.getAccountInfo(CONFIG);
  if (!info) throw new Error(`Config ${CONFIG.toBase58()} not found`);
  const c = decodeConfig(info.data);
  const now = Math.floor(Date.now() / 1000);
  if (lastConfig) {
    for (const role of ["proposer", "approver", "guardian"] as const) {
      if (lastConfig[role] !== c[role]) roleChanges.push({ role, at: now });
    }
  }
  if (guardian && c.guardian !== guardian.publicKey.toBase58() && !lastConfig) {
    console.warn(`warning: Config guardian is ${c.guardian}, but GUARDIAN_KEYPAIR is ${guardian.publicKey.toBase58()}; vetoes will fail`);
  }
  lastConfig = c;
}

/** First time the mint shows up onchain, or null if it has no history. */
async function firstSeen(mint: PublicKey): Promise<number | null> {
  let before: string | undefined;
  let oldest: number | null = null;
  // ponytail: stops after 10k signatures and calls the mint "at least that old"; fine for a 7-day rule.
  for (let page = 0; page < 10; page++) {
    const sigs = await conn.getSignaturesForAddress(mint, { before, limit: 1000 });
    if (sigs.length === 0) break;
    oldest = sigs[sigs.length - 1].blockTime ?? oldest;
    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1].signature;
  }
  return oldest;
}

async function buildCtx(p: Proposal, ix: ReturnType<typeof decodeTargetIx>): Promise<Ctx> {
  const ctx: Ctx = {
    now: Math.floor(Date.now() / 1000),
    mintHistory: [],
    roleChanges: [...roleChanges, ...governanceChanges()],
    mintMultiple: MINT_MULTIPLE,
    mintCeilingTokens: MINT_CEILING_TOKENS,
  };
  if (ix.mint && (ix.program === "spl-token" || ix.program === "token-2022")) {
    const mint = new PublicKey(ix.mint);
    const [reservePda] = PublicKey.findProgramAddressSync([Buffer.from("reserve"), CONFIG.toBuffer(), mint.toBuffer()], PROGRAM_ID);
    const [mintInfo, reserveInfo] = await conn.getMultipleAccountsInfo([mint, reservePda]);
    if (mintInfo) Object.assign(ctx, decodeMint(mintInfo.data));
    if (reserveInfo) ctx.reserve = decodeReserve(reserveInfo.data);
    // ponytail: only timelocked mints have a Proposal; fast-lane (execute_now) mints aren't in the average.
    for (const q of proposals.values()) {
      if (q.status !== "Executed" || q.targetProgram !== p.targetProgram) continue;
      const qi = decodeTargetIx(q.targetProgram, q.data, q.accounts);
      if ((qi.name === "MintTo" || qi.name === "MintToChecked") && qi.mint === ix.mint && qi.amount !== undefined) {
        ctx.mintHistory.push({ amount: qi.amount, at: q.eta });
      }
    }
  }
  if (ix.name === "list_collateral" && ix.args?.mint) ctx.collateralMintCreatedAt = await firstSeen(new PublicKey(ix.args.mint));
  if (ix.name === "set_withdraw_limit" && ix.named?.vault) {
    const v = await conn.getAccountInfo(new PublicKey(ix.named.vault));
    if (v) ctx.currentWithdrawLimit = decodeAccount(mockVaultIdl, "Vault", v.data).withdraw_limit;
  }
  return ctx;
}

// ---------------------------------------------------------------- decide and act

const inflight = new Set<string>();
const explanations = new Map<string, Awaited<ReturnType<typeof explain>>>();

async function handle(key: string, p: Proposal) {
  if (handled.has(key) || inflight.has(key) || p.status !== "Queued" || p.config !== CONFIG.toBase58()) return;
  inflight.add(key);
  try {
    const ix = decodeTargetIx(p.targetProgram, p.data, p.accounts);
    const hits = evaluate(p, ix, await buildCtx(p, ix), PROGRAM_ID.toBase58());
    if (hits.length === 0) {
      console.log(`proposal #${p.id} ${key}: ${ix.program}.${ix.name}, no rule hit`);
      handled.add(key); // ponytail: evaluated once; a later role change doesn't re-check older proposals.
      return;
    }
    // Cached so a retried veto carries the same reason hash.
    const ex = explanations.get(key) ?? (await explain(p.id, hits));
    explanations.set(key, ex);
    const reason = createHash("sha256").update(ex.text, "utf8").digest();
    let vetoTx: string | null = null;
    if (!DRY_RUN) {
      const vetoIx = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: CONFIG, isSigner: false, isWritable: false },
          { pubkey: guardian!.publicKey, isSigner: true, isWritable: false },
          { pubkey: new PublicKey(key), isSigner: false, isWritable: true },
        ],
        data: vetoData(reason),
      });
      vetoTx = await sendAndConfirmTransaction(conn, new Transaction().add(vetoIx), [guardian!]);
    }
    record({
      ts: new Date().toISOString(),
      proposal: key,
      id: Number(p.id),
      rule: hits[0].rule,
      severity: hits[0].severity,
      explanation: ex.text,
      reason_hash: reason.toString("hex"),
      veto_tx: vetoTx,
    });
    handled.add(key);
    console.log(`${DRY_RUN ? "[dry-run] would veto" : "vetoed"} #${p.id} ${key} (${hits.map((h) => h.rule).join(", ")}; text by ${ex.by})${vetoTx ? ` tx ${vetoTx}` : ""}`);
  } catch (e) {
    console.error(`proposal ${key}: ${e instanceof Error ? e.message : e}; will retry on next poll`);
  } finally {
    inflight.delete(key);
  }
}

function ingest(key: string, data: Buffer) {
  try {
    const p = decodeProposal(data);
    proposals.set(key, p);
    return p;
  } catch (e) {
    console.error(`skipping undecodable proposal ${key}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

const filters = [
  { memcmp: { offset: 0, bytes: accountDisc(vetowallIdl, "Proposal").toString("base64"), encoding: "base64" as const } },
  { memcmp: { offset: 8, bytes: CONFIG.toBase58() } },
];

async function poll() {
  try {
    await watchConfig();
    const accounts = await conn.getProgramAccounts(PROGRAM_ID, { filters });
    for (const a of accounts) ingest(a.pubkey.toBase58(), a.account.data);
    lastPoll = Date.now();
    // Sequential so history is consistent between proposals.
    for (const [key, p] of proposals) await handle(key, p);
  } catch (e) {
    console.error(`poll failed: ${e instanceof Error ? e.message : e}`);
  }
}

// ---------------------------------------------------------------- HTTP

createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const json = (code: number, body: unknown) =>
    void res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (req.method === "GET" && path === "/decisions") return json(200, decisions);
  if (req.method === "GET" && path === "/health") {
    return json(200, {
      ok: Date.now() - lastPoll < POLL_MS * 3,
      dry_run: DRY_RUN,
      guardian: guardian?.publicKey.toBase58() ?? null,
      program: PROGRAM_ID.toBase58(),
      config: CONFIG.toBase58(),
      proposals: proposals.size,
      decisions: decisions.length,
      last_poll: lastPoll ? new Date(lastPoll).toISOString() : null,
    });
  }
  json(404, { error: "not found" });
}).listen(PORT, () => console.log(`guardian ${DRY_RUN ? "(dry run) " : ""}on :${PORT}, program ${PROGRAM_ID.toBase58()}, config ${CONFIG.toBase58()}`));

conn.onProgramAccountChange(
  PROGRAM_ID,
  ({ accountId, accountInfo }) => {
    const p = ingest(accountId.toBase58(), accountInfo.data);
    if (p) void handle(accountId.toBase58(), p);
  },
  { commitment: "confirmed", filters },
);
await poll();
setInterval(poll, POLL_MS);
