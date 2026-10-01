// Browser side: the RPC connection, signers (Phantom via the wallet standard,
// or devnet burner keys), sending, and explorer links. Imported only by client
// components.
import './polyfill';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SendTransactionError, Transaction } from '@solana/web3.js';
import { getWallets } from '@wallet-standard/app';
import idl from './idl/vetowall.json';
export { explorer } from './explorer';

const PUBLIC_DEVNET = 'https://api.devnet.solana.com';
let conn: Connection | undefined;
/**
 * Every browser RPC call goes through this app's /api/rpc proxy, which holds
 * the keyed RPC URL server-side. The proxy can't carry WebSockets, so `send`
 * confirms by polling; the public devnet WSS is set only so web3.js never
 * tries a socket on this origin.
 */
export const connection = () =>
  (conn ??= new Connection(`${location.origin}/api/rpc`, { commitment: 'confirmed', wsEndpoint: 'wss://api.devnet.solana.com' }));
const CHAIN = 'solana:devnet';
type Wallet = ReturnType<ReturnType<typeof getWallets>['get']>[number];
type WalletAccount = Wallet['accounts'][number];

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
  tx.recentBlockhash = (await connection().getLatestBlockhash()).blockhash;
  return tx;
}

/** Polls the signature until it is confirmed or fails; about a minute, like a blockhash's lifetime. */
async function confirm(sig: string) {
  for (let i = 0; i < 60; i++) {
    const { value: [st] } = await connection().getSignatureStatuses([sig]);
    if (st?.err) throw new Error(`Transaction failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('block height exceeded: not confirmed within 60s');
}

/** Devnet faucet. Airdrops aren't proxied (and use no key): they go straight to the public devnet RPC. */
export async function airdrop(to: PublicKey) {
  const sig = await new Connection(PUBLIC_DEVNET, 'confirmed').requestAirdrop(to, LAMPORTS_PER_SOL);
  await confirm(sig);
}

/**
 * With `skipPreflight`, a transaction the program refuses still lands, so the
 * refusal itself is an onchain record (it costs the fee).
 */
export async function send(tx: Transaction, skipPreflight = false): Promise<string> {
  try {
    const sig = await connection().sendRawTransaction(tx.serialize(), { skipPreflight });
    await confirm(sig);
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
  if (e instanceof SendTransactionError) logs = (await e.getLogs(connection()).catch(() => null)) ?? e.logs ?? [];
  const text = logs.join('\n') + '\n' + String((e as Error)?.message ?? e);
  const named = text.match(/Error Code: (\w+)\. Error Number: \d+\. Error Message: ([^\n.]+)/);
  if (named) return `${named[1]}: ${named[2]}`;
  // Codes below 6000 come from the program Vetowall called (e.g. Token-2022), whose own log line says more.
  // A transaction sent with skipPreflight fails at confirmation, as {"Custom":<decimal>}.
  const hex = text.match(/custom program error: 0x([0-9a-f]+)/i)?.[1];
  const err = ERRORS.get(hex ? parseInt(hex, 16) : Number(text.match(/"Custom":(\d+)/)?.[1]));
  if (err) return `${err.name}: ${err.msg}`;
  if (/blockhash not found|block height exceeded/i.test(text)) return 'The signed transaction expired. Propose it again.';
  if (/insufficient (funds|lamports)|no record of a prior credit/i.test(text)) return 'Not enough devnet SOL for fees. Use the airdrop button or faucet.solana.com.';
  const said = logs.filter((l) => l.startsWith('Program log: ') && !/Instruction: |executing proposal/.test(l)).at(-1);
  if (said) return said.slice('Program log: '.length);
  return String((e as Error)?.message ?? e).split('\n')[0];
}
