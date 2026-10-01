// Connection, signers (Phantom via the wallet standard, or devnet burner
// keys), sending, and explorer links.
import { Connection, Keypair, PublicKey, SendTransactionError, Transaction } from '@solana/web3.js';
import { getWallets } from '@wallet-standard/app';
import type { Action } from './model';
import idl from './idl/vetowall.json';

export const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://api.devnet.solana.com';
export const connection = new Connection(RPC_URL, 'confirmed');
const CHAIN = 'solana:devnet';
type Wallet = ReturnType<ReturnType<typeof getWallets>['get']>[number];
type WalletAccount = Wallet['accounts'][number];

export const explorer = (kind: 'address' | 'tx', id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

export interface Signer {
  label: string;
  publicKey: PublicKey;
  /** Adds this key's signature; keeps signatures already present. */
  sign(txs: Transaction[]): Promise<Transaction[]>;
}

export const keypairSigner = (label: string, kp: Keypair): Signer => ({
  label,
  publicKey: kp.publicKey,
  async sign(txs) {
    txs.forEach((tx) => tx.partialSign(kp));
    return txs;
  },
});

// --- Phantom (or any wallet-standard Solana wallet) -------------------------

type SignFeature = {
  signTransaction(
    ...inputs: { account: WalletAccount; transaction: Uint8Array; chain: string }[]
  ): Promise<{ signedTransaction: Uint8Array }[]>;
};

export async function connectWallet(): Promise<Signer> {
  const wallets = getWallets().get().filter((w) => 'solana:signTransaction' in w.features);
  const wallet: Wallet | undefined = wallets.find((w) => w.name === 'Phantom') ?? wallets[0];
  if (!wallet) throw new Error('No Solana wallet found. Install Phantom, or switch on demo keys.');
  const connect = wallet.features['standard:connect'] as { connect(): Promise<{ accounts: readonly WalletAccount[] }> };
  const { accounts } = await connect.connect();
  const account = accounts[0];
  if (!account) throw new Error(`${wallet.name} returned no account`);
  const feature = wallet.features['solana:signTransaction'] as SignFeature;
  return {
    label: wallet.name,
    publicKey: new PublicKey(account.address),
    async sign(txs) {
      const out = await feature.signTransaction(
        ...txs.map((tx) => ({
          account,
          chain: CHAIN,
          transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
        })),
      );
      return out.map((o) => Transaction.from(o.signedTransaction));
    },
  };
}

// --- Demo keys: burner keypairs in localStorage, devnet only ----------------

export type Role = 'proposer' | 'approver' | 'guardian' | 'attestor';
export const ROLES: Role[] = ['proposer', 'approver', 'guardian', 'attestor'];

export function burner(role: Role): Keypair {
  const key = `vetowall.burner.${role}`;
  try {
    const saved = localStorage.getItem(key);
    if (saved) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)));
  } catch {
    /* fall through to a fresh key */
  }
  const kp = Keypair.generate();
  try {
    localStorage.setItem(key, JSON.stringify([...kp.secretKey]));
  } catch {
    /* private mode: key lives for this page only */
  }
  return kp;
}

// --- Sending ------------------------------------------------------------------

export async function prepare(tx: Transaction, feePayer: PublicKey) {
  tx.feePayer = feePayer;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return tx;
}

export async function send(tx: Transaction): Promise<string> {
  try {
    const sig = await connection.sendRawTransaction(tx.serialize());
    const res = await connection.confirmTransaction(sig, 'confirmed');
    if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  } catch (e) {
    throw new Error(await explain(e));
  }
}

/** Builds, signs with every signer in order (fee payer first) and sends. */
export async function run(unsigned: Transaction, signers: Signer[]): Promise<string> {
  let tx = await prepare(unsigned, signers[0].publicKey);
  for (const s of signers) [tx] = await s.sign([tx]);
  return send(tx);
}

const ERRORS = new Map(idl.errors.map((e) => [e.code, e]));

/** Turns a failed send into one readable line, naming the program error if any. */
export async function explain(e: unknown): Promise<string> {
  let logs: string[] = [];
  if (e instanceof SendTransactionError) logs = (await e.getLogs(connection).catch(() => null)) ?? e.logs ?? [];
  const text = logs.join('\n') + '\n' + String((e as Error)?.message ?? e);
  const named = text.match(/Error Code: (\w+)\. Error Number: \d+\. Error Message: ([^\n.]+)/);
  if (named) return `${named[1]}: ${named[2]}`;
  const hex = text.match(/custom program error: 0x([0-9a-f]+)/i);
  const err = hex && ERRORS.get(parseInt(hex[1], 16));
  if (err) return `${err.name}: ${err.msg}`;
  if (/blockhash not found|block height exceeded/i.test(text)) return 'The signed transaction expired. Propose it again.';
  if (/insufficient (funds|lamports)|no record of a prior credit/i.test(text)) return 'Not enough devnet SOL for fees. Use the airdrop button or faucet.solana.com.';
  return String((e as Error)?.message ?? e).split('\n')[0];
}

// --- Browser-local log of actions that leave no Proposal account ------------
// ponytail: fast-lane and refused attempts are only remembered in this
// browser; read them from transaction history once the program records them.

const logKey = (config: string) => `vetowall.log.${config}`;

export function sessionLog(config: string): Action[] {
  try {
    return JSON.parse(localStorage.getItem(logKey(config)) ?? '[]');
  } catch {
    return [];
  }
}

export function appendLog(config: string, a: Action) {
  try {
    localStorage.setItem(logKey(config), JSON.stringify([...sessionLog(config), a]));
  } catch {
    /* not persisted */
  }
}
