/**
 * Authority posture scan for Solana stablecoin and tokenized-asset mints.
 *
 * We read every mint listed in `assets.json` from a mainnet RPC node, collect each address that
 * holds a privileged role on it (mint, freeze, and every Token-2022 extension authority), and
 * then look at what kind of account sits behind that address. The output is `results.json`
 * (full detail) and `SUMMARY.md` (counts and one table), both written next to this file.
 *
 * The file has two halves. The pure half (`classify`, the two layout parsers, `summarize`) never
 * touches the network, so `npm run check` can test it on fixed bytes. The I/O half (`rpc`,
 * `resolveSquadsVault`, `scan`) only fetches accounts and hands them to the pure half.
 *
 * What the scan can and cannot show is spelled out in README.md. The short version: we report
 * who can sign, as far as account data shows it. We do not read program logic, so a cap or a
 * delay enforced inside an issuer's own program is invisible to us and is reported as such.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SQUADS_V4 = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

/**
 * Programs whose signature we never expect on a PDA they own. The token programs own mints and
 * multisigs but never call `invoke_signed`, and the System Program owns every plain wallet. An
 * off-curve address owned by one of these was derived by some other program, and account data
 * alone does not say which.
 */
const NON_SIGNING_OWNERS = new Set([SYSTEM, TOKEN, TOKEN_2022]);

/** Length in bytes of an SPL Token `Multisig` account: m, n, is_initialized, then 11 keys. */
const SPL_MULTISIG_LEN = 355;
const SPL_MULTISIG_MAX_SIGNERS = 11;

/**
 * How many vault indices we try when matching a Squads vault to its multisig. The Squads UI
 * creates vault 0 by default and extra vaults count up from there, so 16 covers ordinary use.
 * A vault with a higher index stays unresolved and is reported as such, never guessed.
 */
const SQUADS_MAX_VAULT_INDEX = 16;

/** How many recent transactions of an address we inspect while looking for its Squads multisig. */
const SQUADS_TX_LOOKBACK = 20;

/** The slice of an account that classification needs. `null` means the address has no account. */
export type Account = { owner: string; data: Buffer } | null;

/** A Squads v4 multisig, reduced to the fields that say who can act and how fast. */
export type SquadsMultisig = {
  multisig: string;
  /** Non-null when one key can change members, threshold and time lock without a vote. */
  configAuthority: string | null;
  threshold: number;
  members: number;
  /** Seconds a proposal must wait between approval and execution. */
  timeLockSeconds: number;
};

/** What stands behind one authority address, as far as account data shows. */
export type Classification =
  | { kind: "none" }
  | { kind: "system-key"; funded: boolean }
  | { kind: "spl-multisig"; m: number; n: number; signers: string[] }
  | ({ kind: "squads-v4-vault"; vaultIndex: number } & SquadsMultisig)
  | { kind: "program-pda"; ownerProgram: string }
  | { kind: "pda-unresolved"; accountOwner: string | null }
  | { kind: "on-curve-program-owned"; ownerProgram: string };

export type Kind = Classification["kind"];

const KIND_LABEL: Record<Kind, string> = {
  none: "none (authority removed)",
  "system-key": "single system-owned key",
  "spl-multisig": "SPL multisig",
  "squads-v4-vault": "Squads v4 vault",
  "program-pda": "PDA with an account owned by a non-system program",
  "pda-unresolved": "PDA, deriving program not resolved",
  "on-curve-program-owned": "on-curve address with a program-owned account",
};

/**
 * Parses an SPL Token `Multisig` account, or returns `null` if the bytes are not one.
 *
 * The layout is fixed by both token programs: `m: u8`, `n: u8`, `is_initialized: u8`, then
 * eleven 32-byte signer slots of which the first `n` are used. We reject anything that breaks
 * `1 <= m <= n <= 11` or is not initialised, because a caller that trusted such bytes would
 * report a threshold that the token program itself would refuse to honour.
 */
export function parseSplMultisig(data: Buffer): { m: number; n: number; signers: string[] } | null {
  if (data.length !== SPL_MULTISIG_LEN) return null;
  const m = data.readUInt8(0);
  const n = data.readUInt8(1);
  if (data.readUInt8(2) !== 1) return null;
  if (m < 1 || m > n || n > SPL_MULTISIG_MAX_SIGNERS) return null;
  const signers: string[] = [];
  for (let i = 0; i < n; i++) {
    signers.push(new PublicKey(data.subarray(3 + 32 * i, 35 + 32 * i)).toBase58());
  }
  return { m, n, signers };
}

/** First 8 bytes of sha256("account:Multisig"), the Anchor tag Squads v4 puts on multisig accounts. */
const SQUADS_MULTISIG_TAG = createHash("sha256").update("account:Multisig").digest().subarray(0, 8);

/**
 * Parses a Squads v4 `Multisig` account, or returns `null` if the bytes are not one.
 *
 * Layout after the 8-byte Anchor tag, from the squads-v4 program source: `create_key` (32),
 * `config_authority` (32), `threshold: u16`, `time_lock: u32`, `transaction_index: u64`,
 * `stale_transaction_index: u64`, `rent_collector: Option<Pubkey>` (1 or 33 bytes), `bump: u8`,
 * then `members` as a u32 length followed by 33 bytes each (key plus permission mask). All
 * integers are little-endian. Every read is bounds-checked first: these bytes come from an RPC
 * node, and a short or foreign account must give `null`, not an exception or a made-up threshold.
 *
 * The caller passes the account's own address so the result can name it. We do not check here
 * that the account is owned by the Squads program; `classify` callers do that before parsing.
 */
export function parseSquadsMultisig(address: string, data: Buffer): SquadsMultisig | null {
  const fixedEnd = 8 + 32 + 32 + 2 + 4 + 8 + 8 + 1;
  if (data.length < fixedEnd) return null;
  if (!data.subarray(0, 8).equals(SQUADS_MULTISIG_TAG)) return null;
  const configAuthority = new PublicKey(data.subarray(40, 72)).toBase58();
  const threshold = data.readUInt16LE(72);
  const timeLockSeconds = data.readUInt32LE(74);
  const rentCollectorTag = data.readUInt8(94);
  if (rentCollectorTag > 1) return null;
  const membersAt = fixedEnd + 32 * rentCollectorTag + 1;
  if (data.length < membersAt + 4) return null;
  const members = data.readUInt32LE(membersAt);
  // A multisig the program accepted always has at least `threshold` members, and they all fit in
  // the account. If either fails we are misreading the layout, so we refuse to report anything.
  if (threshold < 1 || members < threshold || data.length < membersAt + 4 + 33 * members) return null;
  return {
    multisig: address,
    // Squads stores the all-zero key (which is also the System Program id) for "no config authority".
    configAuthority: configAuthority === SYSTEM ? null : configAuthority,
    threshold,
    members,
    timeLockSeconds,
  };
}

/** Returns whether the address is a valid ed25519 point, which means a private key can exist for it. */
function isOnCurve(address: string): boolean {
  return PublicKey.isOnCurve(new PublicKey(address).toBytes());
}

/**
 * Classifies one authority address from its account, without any network access.
 *
 * `squads` is the verified result of `resolveSquadsVault` for this address, if the I/O half
 * found one. We keep that lookup outside so this function stays testable on fixtures.
 *
 * The order of the checks matters. An SPL multisig address is usually on-curve (it was created
 * from a throwaway keypair), yet nobody signs with that keypair: the token program checks the
 * member signatures instead. So the multisig test has to come before the on-curve test, or
 * every multisig would be reported as a single key.
 */
export function classify(address: string | null, account: Account, squads?: SquadsMultisig & { vaultIndex: number }): Classification {
  if (address === null) return { kind: "none" };
  if (squads) return { kind: "squads-v4-vault", ...squads };
  const owner = account?.owner ?? null;
  if (account && (owner === TOKEN || owner === TOKEN_2022)) {
    const multisig = parseSplMultisig(account.data);
    if (multisig) return { kind: "spl-multisig", ...multisig };
  }
  if (isOnCurve(address)) {
    // An address with no account at all is still a usable signer: a wallet only needs lamports to
    // pay fees, not to sign as an authority. We record `funded` so the reader can tell them apart.
    if (owner === null || owner === SYSTEM) return { kind: "system-key", funded: account !== null };
    // On-curve and owned by a program: the account's data belongs to the program, but whoever
    // holds the keypair can still sign as this address. We keep it apart from PDAs for that reason.
    return { kind: "on-curve-program-owned", ownerProgram: owner };
  }
  if (owner !== null && !NON_SIGNING_OWNERS.has(owner)) return { kind: "program-pda", ownerProgram: owner };
  return { kind: "pda-unresolved", accountOwner: owner };
}

/** Whether a delay between deciding and executing can be proven for an authority, and on what basis. */
export type Delay = { provable: boolean; seconds: number | null; basis: string };

/**
 * States what delay, if any, the chain proves for a classified authority.
 *
 * Only a resolved Squads `time_lock` above zero counts as proof. For an SPL multisig we look one
 * level down: it is delayed only if every member is, because any `m` members can act and we do
 * not try to reason about which subsets are slow. For program-derived addresses we say plainly
 * that we did not read the program, since a delay or cap may well exist in its logic.
 */
export function delayOf(c: Classification, signerDelays: Delay[] = []): Delay | null {
  switch (c.kind) {
    case "none":
      return null;
    case "squads-v4-vault":
      return c.timeLockSeconds > 0
        ? { provable: true, seconds: c.timeLockSeconds, basis: `Squads v4 time_lock of multisig ${c.multisig}` }
        : { provable: false, seconds: null, basis: "none visible onchain: Squads v4 time_lock is 0" };
    case "spl-multisig": {
      const all = signerDelays.length === c.n && signerDelays.every((d) => d.provable && d.seconds !== null);
      if (!all) return { provable: false, seconds: null, basis: "none visible onchain: the token program executes as soon as m members sign" };
      const seconds = Math.min(...signerDelays.map((d) => d.seconds ?? 0));
      return { provable: true, seconds, basis: "every multisig member has a provable delay; this is the shortest" };
    }
    case "system-key":
    case "on-curve-program-owned":
      return { provable: false, seconds: null, basis: "none visible onchain: one signature from this key is enough for the token program" };
    case "program-pda":
    case "pda-unresolved":
      return { provable: false, seconds: null, basis: "none visible onchain: program logic was not analysed, so a delay or cap inside it would not show here" };
  }
}

/**
 * Returns whether signatures from system-owned keys are, on their own, enough to use an authority.
 *
 * True for a single key, and for an SPL multisig that has at least `m` system-owned key members.
 * In both cases the instruction goes straight to the token program with no other program in the
 * path, and neither token program applies a delay or a supply cap to a signed instruction. This
 * is the one statement about "no onchain delay or cap" that account data alone can support, so
 * the summary reports it separately from the PDA classes, where we would have to read a program.
 */
export function keysAloneSuffice(c: Classification, signers: Classification[] = []): boolean {
  if (c.kind === "system-key") return true;
  if (c.kind !== "spl-multisig") return false;
  return signers.filter((s) => s.kind === "system-key").length >= c.m;
}

/** One privileged role on a mint and the address that holds it (`null` when it has been removed). */
type Role = { role: string; address: string | null };

/** The fields of the node's `jsonParsed` mint that we use. Anything else is ignored. */
type ParsedMint = {
  decimals: number;
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions?: { extension: string; state?: Record<string, unknown> }[];
};

/**
 * Lists every authority-bearing role on a parsed mint.
 *
 * We let the RPC node decode Token-2022 extensions (`jsonParsed`) instead of carrying our own
 * TLV offsets: the node runs the reference parser, and a wrong offset here would silently
 * attribute an authority to the wrong address. From each extension we take every field whose
 * name ends in "authority", plus the permanent delegate. That rule is anchored at the end of the
 * name on purpose: `withdrawWithheldAuthorityElgamalPubkey` is an encryption key, not a signer,
 * and must not be picked up. A new extension with an authority field is covered without a code
 * change, and one the node cannot decode is surfaced through `unparsed` so we never report a
 * mint as fully read when it was not.
 */
export function rolesOf(mint: ParsedMint): { roles: Role[]; unparsed: number } {
  const roles: Role[] = [
    { role: "mint", address: mint.mintAuthority },
    { role: "freeze", address: mint.freezeAuthority },
  ];
  let unparsed = 0;
  for (const ext of mint.extensions ?? []) {
    if (ext.extension === "unparseableExtension") unparsed++;
    for (const [field, value] of Object.entries(ext.state ?? {})) {
      if (!/authority$/i.test(field) && field !== "delegate") continue;
      if (value !== null && typeof value !== "string") continue;
      roles.push({ role: `${ext.extension}.${field}`, address: value });
    }
  }
  return { roles, unparsed };
}

type Asset = { symbol: string; category: string; mint: string; source: string };
type AuthorityResult = Role & {
  classification: Classification;
  /** Members of an SPL multisig, classified one level down. */
  signers?: { address: string; classification: Classification }[];
  delay: Delay | null;
  keysAloneSuffice: boolean;
};
type AssetResult = Asset & {
  tokenProgram: string;
  decimals: number;
  supplyRaw: string;
  supply: string;
  extensions: string[];
  facts: Record<string, unknown>;
  authorities: AuthorityResult[];
};
type Results = {
  scannedAt: string;
  slot: number;
  blockTime: number | null;
  rpcHost: string;
  assets: AssetResult[];
  skipped: { symbol: string; mint: string; reason: string }[];
};

/** The four roles the summary counts. The other extension authorities stay in `results.json`. */
const HEADLINE_ROLES: [role: string, label: string][] = [
  ["mint", "Mint authority"],
  ["freeze", "Freeze authority"],
  ["permanentDelegate.delegate", "Permanent delegate"],
  ["pausableConfig.authority", "Pause authority"],
];

/** Shortens an address for table cells; the full value is always in `results.json`. */
function short(address: string): string {
  return `${address.slice(0, 4)}..${address.slice(-4)}`;
}

/** Renders a classification as one table cell, with the numbers a reader would ask for first. */
function cell(a: AuthorityResult | undefined): string {
  if (!a) return "not present";
  const c = a.classification;
  switch (c.kind) {
    case "none":
      return "none";
    case "system-key":
      return `key ${short(a.address ?? "")}`;
    case "spl-multisig":
      return `SPL multisig ${c.m}-of-${c.n} ${short(a.address ?? "")}`;
    case "squads-v4-vault":
      return `Squads v4 ${c.threshold}-of-${c.members}, time_lock ${c.timeLockSeconds}s ${short(a.address ?? "")}`;
    case "program-pda":
      return `PDA ${short(a.address ?? "")}, account owned by ${short(c.ownerProgram)}`;
    case "pda-unresolved":
      return `PDA ${short(a.address ?? "")}, program not resolved`;
    case "on-curve-program-owned":
      return `on-curve ${short(a.address ?? "")}, account owned by ${short(c.ownerProgram)}`;
  }
}

/**
 * Builds SUMMARY.md from the results and nothing else.
 *
 * Every number in the text is counted here from `results.assets`, so the summary cannot drift
 * from `results.json`. We count per mint, not per issuer: several mints of one issuer share an
 * authority address, and the "distinct addresses" line under each role shows how much.
 */
export function summarize(r: Results): string {
  const n = r.assets.length;
  const out: string[] = [];
  out.push("# Authority posture of Solana stablecoin and tokenized-asset mints", "");
  out.push(`Generated by \`npm run scan\` from \`results.json\`. Slot ${r.slot}, scanned ${r.scannedAt}, RPC host ${r.rpcHost}.`, "");
  const byCategory = new Map<string, number>();
  for (const a of r.assets) byCategory.set(a.category, (byCategory.get(a.category) ?? 0) + 1);
  out.push(`${n} mints: ${[...byCategory].map(([c, k]) => `${k} ${c}`).join(", ")}. Counts are per mint.`, "");
  out.push("## Headline counts", "");
  for (const [role, label] of HEADLINE_ROLES) {
    const holders = r.assets.map((a) => a.authorities.find((x) => x.role === role));
    const present = holders.filter((h): h is AuthorityResult => h !== undefined);
    const live = present.filter((h) => h.classification.kind !== "none");
    out.push(`### ${label}`, "");
    if (present.length < n) out.push(`- not present on the mint (no such extension): ${n - present.length} of ${n}`);
    for (const kind of Object.keys(KIND_LABEL) as Kind[]) {
      const k = present.filter((h) => h.classification.kind === kind);
      if (k.length === 0) continue;
      let detail = "";
      if (kind === "spl-multisig") {
        const shapes = new Map<string, number>();
        for (const h of k) {
          if (h.classification.kind !== "spl-multisig") continue;
          const s = `${h.classification.m}-of-${h.classification.n}`;
          shapes.set(s, (shapes.get(s) ?? 0) + 1);
        }
        detail = ` (${[...shapes].map(([s, c]) => `${c} x ${s}`).join(", ")})`;
      }
      out.push(`- ${KIND_LABEL[kind]}: ${k.length} of ${n}${detail}`);
    }
    out.push(`- system-owned key signatures alone are enough (single key, or SPL multisig with at least m system-owned key members): ${live.filter((h) => h.keysAloneSuffice).length} of the ${live.length} that are set`);
    const delayed = live.filter((h) => h.delay?.provable);
    out.push(`- provable onchain delay: ${delayed.length} of the ${live.length} that are set; none visible onchain for the other ${live.length - delayed.length}`);
    out.push(`- distinct addresses holding this role: ${new Set(live.map((h) => h.address)).size}`, "");
  }
  out.push("## How to read the counts", "");
  out.push(
    "- \"None visible onchain\" means the account data we read proves no delay. It does not mean there is none.",
    "- A system-owned key may be backed by MPC or an HSM, with approval policies and limits enforced offchain. The chain cannot show that, and it cannot tell such a key from a hot key.",
    "- An issuer may enforce mint caps and review steps offchain, or inside its own program. We did not read any program's logic, so for the two PDA classes a cap or delay may exist that this scan does not see.",
    "- An SPL multisig has no delay feature: the token program acts as soon as m members have signed. We classify its members one level down in `results.json`; a member can itself be a PDA.",
    "- \"Key signatures alone are enough\" means the instruction reaches the token program with no other program in the path. Neither SPL Token nor Token-2022 applies a delay or a supply cap to a signed instruction.",
    "- Supply is in whole tokens, rounded down. Addresses are shortened here and given in full in `results.json`.",
    "- The stock tokens are a sample of two issuers, four mints each, so they move the totals by issuer, not by market share.",
    "",
  );
  out.push("## Per mint", "");
  out.push("| Asset | Category | Program | Supply | Mint authority | Freeze authority | Permanent delegate | Pause authority | Other extension authorities set |");
  out.push("|-|-|-|-|-|-|-|-|-|");
  const headline = new Set(HEADLINE_ROLES.map(([role]) => role));
  for (const a of r.assets) {
    const find = (role: string) => a.authorities.find((x) => x.role === role);
    const other = a.authorities.filter((x) => !headline.has(x.role) && x.address !== null);
    const otherCell = other.length === 0 ? "0" : `${other.length} roles on ${new Set(other.map((x) => x.address)).size} address(es)`;
    const program = a.tokenProgram === TOKEN ? "Token" : "Token-2022";
    out.push(`| ${a.symbol} | ${a.category} | ${program} | ${a.supply} | ${HEADLINE_ROLES.map(([role]) => cell(find(role))).join(" | ")} | ${otherCell} |`);
  }
  out.push("");
  if (r.skipped.length > 0) {
    out.push("## Skipped", "", ...r.skipped.map((s) => `- ${s.symbol} (${s.mint}): ${s.reason}`), "");
  }
  return out.join("\n");
}

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends one JSON-RPC request and returns its `result`.
 *
 * Public endpoints answer 429 under light load, so we retry up to 7 times with a doubling pause
 * that starts at 500 ms (about a minute in total) on 429, on any 5xx and on a network error or
 * timeout. Each attempt has a 30 s deadline, so a silent node cannot hang the scan. Any other
 * failure is final. Error text names the method only: the URL may carry an API key, and we never
 * want it in a terminal log or a CI transcript.
 */
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let last = "no attempt made";
  for (let attempt = 0; attempt < 7; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      last = e instanceof Error ? e.name : "network error";
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      last = `HTTP ${res.status}`;
      continue;
    }
    if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) {
      if (body.error.code === 429 || body.error.code === -32429) {
        last = `RPC error ${body.error.code}`;
        continue;
      }
      throw new Error(`RPC ${method} failed: ${body.error.code} ${body.error.message}`);
    }
    if (body.result === undefined) throw new Error(`RPC ${method} returned no result`);
    return body.result;
  }
  throw new Error(`RPC ${method} failed after retries: ${last}`);
}

type RawAccount = { owner: string; data: unknown } | null;

/**
 * Fetches many accounts in batches of 100, the `getMultipleAccounts` limit.
 *
 * Returns the values in input order and the slot of the first batch. The batches are not one
 * atomic snapshot; for a posture scan a few slots of skew between mints is not a concern, and
 * the slot we report is the one the mint accounts were read at.
 */
async function getAccounts(addresses: string[], encoding: "base64" | "jsonParsed"): Promise<{ slot: number; value: RawAccount[] }> {
  const value: RawAccount[] = [];
  let slot = 0;
  for (let i = 0; i < addresses.length; i += 100) {
    const res = await rpc<{ context: { slot: number }; value: RawAccount[] }>("getMultipleAccounts", [addresses.slice(i, i + 100), { encoding }]);
    if (i === 0) slot = res.context.slot;
    value.push(...res.value);
  }
  return { slot, value };
}

/** Converts a base64-encoded RPC account into the shape `classify` takes. */
function toAccount(raw: RawAccount): Account {
  if (raw === null) return null;
  const data = Array.isArray(raw.data) && typeof raw.data[0] === "string" ? Buffer.from(raw.data[0], "base64") : Buffer.alloc(0);
  return { owner: raw.owner, data };
}

/**
 * Tries to prove that an off-curve address is a Squads v4 vault, and returns its multisig.
 *
 * A vault is a PDA of the Squads program with seeds `["multisig", multisig, "vault", index]`. It
 * holds no data, so nothing in the vault account points back to the multisig. We find candidates
 * the cheap way: every transaction a vault signs also carries its multisig account, so we look
 * at the last few transactions that mention the address, collect the accounts in those that call
 * the Squads program, and keep the ones that are Squads-owned and parse as a multisig. A
 * candidate is accepted only if re-deriving the vault PDA from it gives exactly this address.
 * That derivation is the proof; the transaction history is only where we look for candidates.
 *
 * Returns `null` when no candidate passes. That means "not shown to be a Squads v4 vault", for
 * example a vault with no recent activity, a vault index of 16 or more, or a PDA of some other
 * program. The caller reports it as unresolved.
 */
async function resolveSquadsVault(address: string): Promise<(SquadsMultisig & { vaultIndex: number }) | null> {
  const signatures = await rpc<{ signature: string }[]>("getSignaturesForAddress", [address, { limit: SQUADS_TX_LOOKBACK }]);
  const seen = new Set<string>();
  for (const { signature } of signatures) {
    const tx = await rpc<{
      transaction: { message: { accountKeys: string[] } };
      meta: { loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
    } | null>("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 1 }]);
    if (!tx) continue;
    const keys = [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
    if (!keys.includes(SQUADS_V4)) continue;
    const fresh = keys.filter((k) => !seen.has(k));
    for (const k of fresh) seen.add(k);
    const { value } = await getAccounts(fresh, "base64");
    for (const [i, raw] of value.entries()) {
      const candidate = fresh[i];
      if (candidate === undefined || raw?.owner !== SQUADS_V4) continue;
      const multisig = parseSquadsMultisig(candidate, toAccount(raw)?.data ?? Buffer.alloc(0));
      if (!multisig) continue;
      for (let vaultIndex = 0; vaultIndex < SQUADS_MAX_VAULT_INDEX; vaultIndex++) {
        const [vault] = PublicKey.findProgramAddressSync(
          [Buffer.from("multisig"), new PublicKey(candidate).toBuffer(), Buffer.from("vault"), Buffer.from([vaultIndex])],
          new PublicKey(SQUADS_V4),
        );
        if (vault.toBase58() === address) return { ...multisig, vaultIndex };
      }
    }
  }
  return null;
}

/** Formats a raw token amount as a decimal string without going through floating point. */
function formatSupply(raw: string, decimals: number): string {
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Runs the scan: read mints, read authority accounts, classify, and return the results.
 *
 * A mint that is missing, not owned by a token program, or not decodable by the node is put in
 * `skipped` with the reason and left out of every count. We prefer a shorter list to a row we
 * cannot stand behind.
 */
async function scan(assets: Asset[]): Promise<Results> {
  const mints = await getAccounts(assets.map((a) => a.mint), "jsonParsed");
  const skipped: Results["skipped"] = [];
  const read: { asset: Asset; tokenProgram: string; mint: ParsedMint; roles: Role[] }[] = [];
  for (const [i, asset] of assets.entries()) {
    const raw = mints.value[i] ?? null;
    const skip = (reason: string) => skipped.push({ symbol: asset.symbol, mint: asset.mint, reason });
    if (raw === null) { skip("no account at this address"); continue; }
    if (raw.owner !== TOKEN && raw.owner !== TOKEN_2022) { skip(`owner ${raw.owner} is not a token program`); continue; }
    const parsed = (raw.data as { parsed?: { type?: string; info?: ParsedMint } }).parsed;
    if (parsed?.type !== "mint" || !parsed.info) { skip("account is not a mint the RPC node can decode"); continue; }
    const { roles, unparsed } = rolesOf(parsed.info);
    if (unparsed > 0) { skip(`${unparsed} extension(s) the RPC node could not decode`); continue; }
    read.push({ asset, tokenProgram: raw.owner, mint: parsed.info, roles });
  }

  // First pass: the authority addresses themselves. Second pass: members of any SPL multisig
  // among them, so the report can say what stands behind a 1-of-n.
  const accounts = new Map<string, Account>();
  const fetchInto = async (addresses: string[]) => {
    const missing = [...new Set(addresses)].filter((a) => !accounts.has(a));
    const { value } = await getAccounts(missing, "base64");
    for (const [i, a] of missing.entries()) accounts.set(a, toAccount(value[i] ?? null));
  };
  const authorityAddresses = read.flatMap((m) => m.roles.flatMap((r) => (r.address === null ? [] : [r.address])));
  await fetchInto(authorityAddresses);
  const signerAddresses = authorityAddresses.flatMap((a) => {
    const c = classify(a, accounts.get(a) ?? null);
    return c.kind === "spl-multisig" ? c.signers : [];
  });
  await fetchInto(signerAddresses);

  // Squads vaults are data-less PDAs, so they first show up as "unresolved". Only those are worth
  // the extra transaction lookups.
  const squads = new Map<string, SquadsMultisig & { vaultIndex: number }>();
  for (const address of accounts.keys()) {
    if (classify(address, accounts.get(address) ?? null).kind !== "pda-unresolved") continue;
    const resolved = await resolveSquadsVault(address);
    if (resolved) squads.set(address, resolved);
  }
  const classified = (address: string | null) => classify(address, address === null ? null : accounts.get(address) ?? null, address === null ? undefined : squads.get(address));

  const results: AssetResult[] = read.map(({ asset, tokenProgram, mint, roles }) => {
    const facts: Record<string, unknown> = {};
    for (const ext of mint.extensions ?? []) {
      const s = ext.state ?? {};
      if (ext.extension === "pausableConfig") facts.paused = s.paused;
      if (ext.extension === "defaultAccountState") facts.defaultAccountState = s.accountState;
      if (ext.extension === "transferHook") facts.transferHookProgram = s.programId;
      if (ext.extension === "scaledUiAmountConfig") facts.uiAmountMultiplier = s.multiplier;
    }
    const authorities = roles.map((role): AuthorityResult => {
      const classification = classified(role.address);
      if (classification.kind !== "spl-multisig") return { ...role, classification, delay: delayOf(classification), keysAloneSuffice: keysAloneSuffice(classification) };
      const signers = classification.signers.map((address) => ({ address, classification: classified(address) }));
      const signerDelays = signers.flatMap((s) => delayOf(s.classification) ?? []);
      const keysAlone = keysAloneSuffice(classification, signers.map((s) => s.classification));
      return { ...role, classification, signers, delay: delayOf(classification, signerDelays), keysAloneSuffice: keysAlone };
    });
    return {
      ...asset,
      tokenProgram,
      decimals: mint.decimals,
      supplyRaw: mint.supply,
      supply: formatSupply(mint.supply, mint.decimals),
      extensions: (mint.extensions ?? []).map((e) => e.extension),
      facts,
      authorities,
    };
  });

  // getBlockTime can fail for a slot the node has not finalised or has pruned. The slot is the
  // real anchor, so a missing time is recorded as null instead of failing the scan.
  const blockTime = await rpc<number | null>("getBlockTime", [mints.slot]).catch(() => null);
  return { scannedAt: new Date().toISOString(), slot: mints.slot, blockTime, rpcHost: new URL(RPC_URL).host, assets: results, skipped };
}

/**
 * Offline self-check of the parsing and classification logic (`npm run check`).
 *
 * The multisig fixture is the real account behind PYUSD's mint authority
 * (8Jornc27vtAYPkwDzsZVgLQchAYyC8nD7aCNPCDV8Qk2), captured on 2026-10-06. Using real bytes means
 * the layout is checked against what the token program wrote, not against our own reading of it.
 * The Squads fixture is built by hand from the documented layout, so it checks our bounds and
 * offsets against each other but not against the deployed program; the scan covers that by
 * re-deriving the vault address.
 */
function check(): void {
  const fx = JSON.parse(readFileSync(new URL("fixtures.json", import.meta.url), "utf8")) as { pyusdMintAuthority: { address: string; owner: string; dataBase64: string } };
  const ms = fx.pyusdMintAuthority;
  const data = Buffer.from(ms.dataBase64, "base64");
  const multisig = classify(ms.address, { owner: ms.owner, data });
  assert.equal(multisig.kind, "spl-multisig");
  assert.deepEqual([multisig.kind === "spl-multisig" && multisig.m, multisig.kind === "spl-multisig" && multisig.n], [1, 4]);
  assert.equal(delayOf(multisig)?.provable, false);
  const systemKey: Classification = { kind: "system-key", funded: true };
  const somePda: Classification = { kind: "pda-unresolved", accountOwner: null };
  assert.equal(keysAloneSuffice(multisig, [systemKey, somePda, somePda, somePda]), true, "1-of-4 with one key member");
  assert.equal(keysAloneSuffice(multisig, [somePda, somePda, somePda, somePda]), false);
  assert.equal(keysAloneSuffice(systemKey), true);
  assert.equal(keysAloneSuffice(somePda), false);

  // Deny paths: wrong length, not initialised, m above n, and the right bytes under the wrong owner.
  assert.equal(parseSplMultisig(data.subarray(0, 354)), null);
  const uninit = Buffer.from(data); uninit[2] = 0;
  assert.equal(parseSplMultisig(uninit), null);
  const badM = Buffer.from(data); badM[0] = 5;
  assert.equal(parseSplMultisig(badM), null);
  assert.notEqual(classify(ms.address, { owner: SQUADS_V4, data }).kind, "spl-multisig");

  const key = "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk";
  assert.deepEqual(classify(null, null), { kind: "none" });
  assert.equal(delayOf({ kind: "none" }), null);
  assert.deepEqual(classify(key, { owner: SYSTEM, data: Buffer.alloc(0) }), { kind: "system-key", funded: true });
  assert.deepEqual(classify(key, null), { kind: "system-key", funded: false });

  // Off-curve addresses: we derive one so the fixture cannot go stale.
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("fixture")], new PublicKey(SQUADS_V4));
  const off = pda.toBase58();
  assert.deepEqual(classify(off, null), { kind: "pda-unresolved", accountOwner: null });
  assert.deepEqual(classify(off, { owner: TOKEN_2022, data: Buffer.alloc(82) }), { kind: "pda-unresolved", accountOwner: TOKEN_2022 });
  assert.deepEqual(classify(off, { owner: SQUADS_V4, data: Buffer.alloc(8) }), { kind: "program-pda", ownerProgram: SQUADS_V4 });

  // Squads multisig: 2-of-3, time_lock 3600 s, no config authority, no rent collector.
  const sq = Buffer.alloc(8 + 32 + 32 + 2 + 4 + 8 + 8 + 1 + 1 + 4 + 33 * 3);
  SQUADS_MULTISIG_TAG.copy(sq, 0);
  sq.writeUInt16LE(2, 72);
  sq.writeUInt32LE(3600, 74);
  sq.writeUInt32LE(3, 96);
  const parsed = parseSquadsMultisig(off, sq);
  assert.deepEqual(parsed, { multisig: off, configAuthority: null, threshold: 2, members: 3, timeLockSeconds: 3600 });
  assert.equal(parseSquadsMultisig(off, sq.subarray(0, sq.length - 1)), null, "members must fit in the account");
  assert.equal(parseSquadsMultisig(off, Buffer.alloc(sq.length)), null, "wrong tag");
  assert.ok(parsed);
  const vault = classify(off, null, { ...parsed, vaultIndex: 0 });
  assert.deepEqual(delayOf(vault), { provable: true, seconds: 3600, basis: `Squads v4 time_lock of multisig ${off}` });
  assert.equal(delayOf(classify(off, null, { ...parsed, timeLockSeconds: 0, vaultIndex: 0 }))?.provable, false);

  // Role extraction must pick up signers and must not pick up the ElGamal encryption key.
  const { roles, unparsed } = rolesOf({
    decimals: 6, supply: "0", mintAuthority: key, freezeAuthority: null,
    extensions: [
      { extension: "permanentDelegate", state: { delegate: key } },
      { extension: "confidentialTransferFeeConfig", state: { authority: null, withdrawWithheldAuthorityElgamalPubkey: "HDfmQztzBN2Cc3rkDZuL88SfWw5sSajVMyiz5QaQHFc=" } },
      { extension: "unparseableExtension" },
    ],
  });
  assert.deepEqual(roles.map((r) => r.role), ["mint", "freeze", "permanentDelegate.delegate", "confidentialTransferFeeConfig.authority"]);
  assert.equal(unparsed, 1);
  assert.equal(formatSupply("700819874739173", 6), "700,819,874");
  assert.equal(formatSupply("5", 6), "0");
  console.log("check: ok");
}

/** Entry point: `--check` runs the offline self-check, anything else runs the live scan. */
async function main(): Promise<void> {
  if (process.argv.includes("--check")) return check();
  const here = (name: string) => new URL(name, import.meta.url);
  const assets = JSON.parse(readFileSync(here("assets.json"), "utf8")) as Asset[];
  const results = await scan(assets);
  writeFileSync(here("results.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(here("SUMMARY.md"), summarize(results));
  console.log(`scanned ${results.assets.length} mints at slot ${results.slot}, skipped ${results.skipped.length}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
