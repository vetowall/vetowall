// Every byte the guardian reads from chain is decoded here, so a layout change
// (the v2 IDL) touches this file and nothing else.
//
// Accounts and mock_vault instructions are decoded from the Anchor IDLs in
// ../idl. SPL Token / Token-2022 instructions are decoded by hand, since they
// have no Anchor IDL.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";

type IdlType = string | { vec: IdlType } | { option: IdlType } | { array: [IdlType, number] } | { defined: { name: string } };
type IdlField = { name: string; type: IdlType };
type IdlTypeDef = {
  name: string;
  type: { kind: "struct"; fields: IdlField[] } | { kind: "enum"; variants: { name: string; fields?: (IdlField | IdlType)[] }[] };
};
export type Idl = {
  address: string;
  instructions: { name: string; discriminator: number[]; accounts: { name: string }[]; args: IdlField[] }[];
  accounts?: { name: string; discriminator: number[] }[];
  types?: IdlTypeDef[];
};

const loadIdl = (name: string): Idl =>
  JSON.parse(readFileSync(new URL(`../idl/${name}.json`, import.meta.url), "utf8"));
export const vetowallIdl = loadIdl("vetowall");
export const mockVaultIdl = loadIdl("mock_vault");

// v2 types the v1 IDL doesn't have yet, written from docs/SPEC.md. The IDL's own
// definition wins as soon as it has one.
const SPEC_TYPES: IdlTypeDef[] = [
  {
    name: "Reserve",
    type: {
      kind: "struct",
      fields: [
        { name: "config", type: "pubkey" },
        { name: "mint", type: "pubkey" },
        { name: "attestor", type: "pubkey" },
        { name: "amount", type: "u64" },
        { name: "updated_at", type: "i64" },
        { name: "max_age", type: "i64" },
      ],
    },
  },
];

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest();
export const anchorDisc = (kind: "account" | "global", name: string) => sha256(`${kind}:${name}`).subarray(0, 8);

export function accountDisc(idl: Idl, name: string): Buffer {
  const d = idl.accounts?.find((a) => a.name === name)?.discriminator;
  return d ? Buffer.from(d) : anchorDisc("account", name);
}

export function ixDisc(idl: Idl, name: string): Buffer {
  const d = idl.instructions.find((i) => i.name === name)?.discriminator;
  return d ? Buffer.from(d) : anchorDisc("global", name);
}

/** Borsh reader driven by IDL type definitions. Integers wider than 32 bits come back as bigint. */
class Reader {
  off = 0;
  buf: Buffer;
  types: IdlTypeDef[];
  constructor(buf: Buffer, types: IdlTypeDef[]) {
    this.buf = buf;
    this.types = types;
  }

  read(t: IdlType): unknown {
    const b = this.buf;
    const take = (n: number) => {
      if (this.off + n > b.length) throw new RangeError("account data too short");
      const at = this.off;
      this.off += n;
      return at;
    };
    if (typeof t === "string") {
      switch (t) {
        case "bool": return b[take(1)] !== 0;
        case "u8": return b.readUInt8(take(1));
        case "i8": return b.readInt8(take(1));
        case "u16": return b.readUInt16LE(take(2));
        case "i16": return b.readInt16LE(take(2));
        case "u32": return b.readUInt32LE(take(4));
        case "i32": return b.readInt32LE(take(4));
        case "u64": return b.readBigUInt64LE(take(8));
        case "i64": return b.readBigInt64LE(take(8));
        case "pubkey": return new PublicKey(b.subarray(take(32), this.off)).toBase58();
        case "bytes": {
          const n = b.readUInt32LE(take(4));
          return Uint8Array.from(b.subarray(take(n), this.off));
        }
        case "string": {
          const n = b.readUInt32LE(take(4));
          return b.toString("utf8", take(n), this.off);
        }
        default: throw new Error(`unsupported IDL type ${t}`);
      }
    }
    if ("vec" in t) {
      const n = b.readUInt32LE(take(4));
      return Array.from({ length: n }, () => this.read(t.vec));
    }
    if ("option" in t) return b[take(1)] ? this.read(t.option) : null;
    if ("array" in t) {
      if (t.array[0] === "u8") return Uint8Array.from(b.subarray(take(t.array[1]), this.off));
      return Array.from({ length: t.array[1] }, () => this.read(t.array[0]));
    }
    const def = this.types.find((d) => d.name === t.defined.name);
    if (!def) throw new Error(`unknown IDL type ${t.defined.name}`);
    if (def.type.kind === "struct") return this.fields(def.type.fields);
    const v = def.type.variants[b[take(1)]];
    if (!v) throw new Error(`bad ${def.name} variant`);
    if (!v.fields?.length) return v.name;
    return { [v.name]: v.fields.map((f) => this.read(typeof f === "object" && "name" in f ? f.type : f)) };
  }

  fields(fields: IdlField[]): Record<string, unknown> {
    return Object.fromEntries(fields.map((f) => [f.name, this.read(f.type)]));
  }
}

const typesOf = (idl: Idl) => [...(idl.types ?? []), ...SPEC_TYPES.filter((s) => !idl.types?.some((t) => t.name === s.name))];

/** Decodes an Anchor account. Trailing bytes are ignored, so fields appended in v2 don't break v1 decoding. */
export function decodeAccount(idl: Idl, name: string, data: Uint8Array): Record<string, any> {
  const buf = Buffer.from(data);
  if (!buf.subarray(0, 8).equals(accountDisc(idl, name))) throw new Error(`not a ${name} account`);
  const r = new Reader(buf, typesOf(idl));
  r.off = 8;
  return r.read({ defined: { name } }) as Record<string, any>;
}

// ---------------------------------------------------------------- Vetowall

export type ActionClass = "Safe" | "Params" | "Authority" | "Max";
export type Meta = { pubkey: string; isSigner: boolean; isWritable: boolean };
export type Proposal = {
  config: string;
  id: bigint;
  targetProgram: string;
  accounts: Meta[];
  data: Uint8Array;
  class: ActionClass;
  queuedAt: number;
  eta: number;
  status: "Queued" | "Executed" | "Vetoed";
  /** v2 only: amount recorded for policies with a limit. */
  amount: bigint | null;
};

export function decodeProposal(data: Uint8Array): Proposal {
  const p = decodeAccount(vetowallIdl, "Proposal", data);
  return {
    config: p.config,
    id: p.id,
    targetProgram: p.target_program,
    accounts: p.accounts.map((m: any) => ({ pubkey: m.pubkey, isSigner: m.is_signer, isWritable: m.is_writable })),
    data: p.data,
    class: p.class,
    queuedAt: Number(p.queued_at),
    eta: Number(p.eta),
    status: p.status,
    amount: p.amount ?? null,
  };
}

export type Config = { proposer: string; approver: string | null; guardian: string; sealed: boolean };

export function decodeConfig(data: Uint8Array): Config {
  const c = decodeAccount(vetowallIdl, "Config", data);
  return { proposer: c.proposer, approver: c.approver ?? null, guardian: c.guardian, sealed: c.sealed };
}

export type Reserve = { mint: string; amount: bigint; updatedAt: number; maxAge: number };

export function decodeReserve(data: Uint8Array): Reserve {
  const r = decodeAccount(vetowallIdl, "Reserve", data);
  return { mint: r.mint, amount: r.amount, updatedAt: Number(r.updated_at), maxAge: Number(r.max_age) };
}

/** SPL mint layout, the same for Token and Token-2022: supply at 36..44, decimals at 44. */
export function decodeMint(data: Uint8Array): { supply: bigint; decimals: number } {
  const b = Buffer.from(data);
  return { supply: b.readBigUInt64LE(36), decimals: b[44] };
}

export function vetoData(reason: Uint8Array): Buffer {
  return Buffer.concat([ixDisc(vetowallIdl, "veto"), reason]);
}

// ---------------------------------------------------------------- target instructions

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Token-2022 PausableExtension tag; sub-tags 0 Initialize, 1 Pause, 2 Resume (spl-token-2022-interface 2.1.0). */
export const PAUSABLE_TAG = 44;

const AUTHORITY_TYPES = [
  "MintTokens", "FreezeAccount", "AccountOwner", "CloseAccount", "TransferFeeConfig", "WithheldWithdraw",
  "CloseMint", "InterestRate", "PermanentDelegate", "ConfidentialTransferMint", "TransferHookProgramId",
  "ConfidentialTransferFeeConfig", "MetadataPointer", "GroupPointer", "GroupMemberPointer", "ScaledUiAmount", "Pause",
];

export type TargetIx = {
  program: "spl-token" | "token-2022" | "mock_vault" | "vetowall" | "unknown";
  name: string;
  /** Token amount in base units (MintTo, MintToChecked, Burn, BurnChecked). */
  amount?: bigint;
  decimals?: number;
  /** The mint the instruction acts on, when it names one. */
  mint?: string;
  authorityType?: string;
  newAuthority?: string | null;
  /** Anchor instruction args (mock_vault, vetowall), by IDL name. */
  args?: Record<string, any>;
  /** Accounts by IDL name (mock_vault). */
  named?: Record<string, string>;
};

export function decodeTargetIx(programId: string, data: Uint8Array, accounts: Meta[]): TargetIx {
  const b = Buffer.from(data);
  const key = (i: number) => accounts[i]?.pubkey;
  if (programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) {
    const program = programId === TOKEN_PROGRAM ? "spl-token" : "token-2022";
    const u64 = () => (b.length >= 9 ? b.readBigUInt64LE(1) : undefined);
    switch (b[0]) {
      case 7: return { program, name: "MintTo", amount: u64(), mint: key(0) };
      case 14: return { program, name: "MintToChecked", amount: u64(), decimals: b[9], mint: key(0) };
      case 8: return { program, name: "Burn", amount: u64(), mint: key(1) };
      case 15: return { program, name: "BurnChecked", amount: u64(), decimals: b[9], mint: key(1) };
      case 10: return { program, name: "FreezeAccount", mint: key(1) };
      case 11: return { program, name: "ThawAccount", mint: key(1) };
      case 6: return {
        program,
        name: "SetAuthority",
        authorityType: AUTHORITY_TYPES[b[1]] ?? `Unknown(${b[1]})`,
        newAuthority: b[2] === 1 && b.length >= 35 ? new PublicKey(b.subarray(3, 35)).toBase58() : null,
        mint: key(0),
      };
      case PAUSABLE_TAG: {
        const sub = ["Initialize", "Pause", "Resume"][b[1]] ?? `Unknown(${b[1]})`;
        return { program, name: `Pausable.${sub}`, mint: key(0) };
      }
      default: return { program, name: `Tag${b[0]}` };
    }
  }
  // Vetowall's own instructions are decoded too: a queued change to its config is a proposal like any other.
  for (const [program, idl] of [["mock_vault", mockVaultIdl], ["vetowall", vetowallIdl]] as const) {
    if (programId !== idl.address) continue;
    const ix = idl.instructions.find((i) => b.subarray(0, 8).equals(Buffer.from(i.discriminator)));
    if (!ix) return { program, name: "unknown" };
    const r = new Reader(b, typesOf(idl));
    r.off = 8;
    const named = Object.fromEntries(ix.accounts.map((a, i) => [a.name, key(i)]).filter(([, k]) => k));
    return { program, name: ix.name, args: r.fields(ix.args), named };
  }
  return { program: "unknown", name: "unknown" };
}
