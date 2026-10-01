// Seeds the live devnet demo with the console's own modules: role keys, a
// Token-2022 "vUSD" mint whose every authority is the Vetowall PDA, the
// issuer policy pack (docs/SPEC.md), attested reserves, then a short history:
// a fast-lane mint, a refused mint, a queued mint and a vetoed SetAuthority.
//
//   npm run seed:devnet                                    # devnet
//   VITE_RPC_URL=http://127.0.0.1:8899 npm run seed:devnet  # local validator
//
// The payer is ~/.config/solana/id.json (admin and fee payer). Role keys are
// created once in ~/worldsfair/keys/devnet-demo/ and reused; each run makes a
// new config and mint, so re-running is safe.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { AuthorityType, createSetAuthorityInstruction } from '@solana/spl-token';
import { RPC_URL, connection, explorer, keypairSigner, prepare, run, type Signer } from '../src/chain';
import { errorName } from '../src/records';
import { TOKEN_2022, ata, launchTx, mintToIx } from '../src/token';
import { attestIx, executeNowIx, pda, queueIx, setupIxs, vetoIx } from '../src/vetowall';

const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);
const vusd = (n: number) => BigInt(n) * UNIT;
const DELAYS: [number, number, number, number] = [0, 120, 180, 300];
const DAILY_CAP = vusd(5_000_000);
const RESERVES = vusd(10_000_000);
const FAST_MINT = vusd(1_000_000);
const REFUSED_MINT = vusd(80_000_000);
const QUEUED_MINT = vusd(3_000_000);
const KEY_DIR = join(homedir(), 'worldsfair', 'keys', 'devnet-demo');
const ROLES = ['proposer', 'approver', 'guardian', 'attestor'] as const;
/** Rent for two max-size Proposal accounts plus headroom; the payer pays every fee. */
const FUNDING: Record<(typeof ROLES)[number], number> = { proposer: 0.05, approver: 0.01, guardian: 0.01, attestor: 0.01 };
const VETO_REASON =
  'Proposal #1 would move the vUSD mint authority from the Vetowall authority PDA to an outside wallet. That wallet could then mint ' +
  'without approval, timelock or reserve checks. Vetoed under the rule that no authority may leave Vetowall.';

if (/mainnet/i.test(RPC_URL)) throw new Error(`Refusing to seed ${RPC_URL}: devnet or a local validator only.`);
const cluster = RPC_URL.includes('devnet') ? '' : `&customUrl=${encodeURIComponent(RPC_URL)}`;
const link = (kind: 'address' | 'tx', id: string) =>
  cluster ? explorer(kind, id).replace('cluster=devnet', `cluster=custom${cluster}`) : explorer(kind, id);

const readKey = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));

function roleKey(role: string): Keypair {
  const path = join(KEY_DIR, `${role}.json`);
  if (existsSync(path)) return readKey(path);
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  chmodSync(path, 0o600); // in case the umask widened it
  return kp;
}

const log: [string, string][] = [];
async function step(label: string, ixs: TransactionInstruction[], signers: Signer[]) {
  const sig = await run(new Transaction().add(...ixs), signers);
  log.push([label, sig]);
  console.log(`  ✓ ${label}  ${sig}`);
  return sig;
}

async function logsOf(sig: string) {
  const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  return tx?.meta?.logMessages ?? [];
}

async function main() {
  const payerKp = readKey(join(homedir(), '.config', 'solana', 'id.json'));
  const payer = keypairSigner('payer', payerKp);
  console.log(`RPC ${RPC_URL}\nPayer ${payerKp.publicKey.toBase58()} (${(await connection.getBalance(payerKp.publicKey)) / LAMPORTS_PER_SOL} SOL)`);

  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const keys = Object.fromEntries(ROLES.map((r) => [r, roleKey(r)])) as Record<(typeof ROLES)[number], Keypair>;
  const signer = Object.fromEntries(ROLES.map((r) => [r, keypairSigner(r, keys[r])])) as Record<(typeof ROLES)[number], Signer>;

  // Top up only what's missing, so re-runs don't keep draining the payer.
  const topUps: TransactionInstruction[] = [];
  for (const r of ROLES) {
    const want = FUNDING[r] * LAMPORTS_PER_SOL;
    const have = await connection.getBalance(keys[r].publicKey);
    if (have < want) topUps.push(SystemProgram.transfer({ fromPubkey: payerKp.publicKey, toPubkey: keys[r].publicKey, lamports: want - have }));
  }
  if (topUps.length) await step('Fund role keys', topUps, [payer]);

  const config = Keypair.generate();
  const mint = Keypair.generate();
  const authority = pda.authority(config.publicKey);
  const reserve = pda.reserve(config.publicKey, mint.publicKey);
  const treasury = ata(payerKp.publicKey, mint.publicKey);
  const roles = { config: config.publicKey, proposer: keys.proposer.publicKey, approver: keys.approver.publicKey };
  const mintTo = (amount: bigint) => mintToIx(mint.publicKey, treasury, authority, amount);

  // The console's Launch path: mint with every authority on the PDA, then config, policies, seal, reserves.
  const launch = await launchTx(connection, payerKp.publicKey, mint, authority, { name: 'Vetowall USD', symbol: 'vUSD', uri: '', decimals: DECIMALS });
  await step('Create vUSD, every authority on the Vetowall PDA', launch.instructions, [payer, keypairSigner('mint', mint)]);
  const [init, policiesA, policiesB] = await setupIxs({
    admin: payerKp.publicKey,
    config: config.publicKey,
    mint: mint.publicKey,
    proposer: keys.proposer.publicKey,
    approver: keys.approver.publicKey,
    guardian: keys.guardian.publicKey,
    attestor: keys.attestor.publicKey,
    delays: DELAYS,
    dailyCap: DAILY_CAP,
    maxAge: 86400,
  });
  const initSig = await step('Initialize config and reserve', init, [payer, keypairSigner('config', config)]);
  if (!(await logsOf(initSig)).some((l) => l.startsWith('Program data: '))) {
    throw new Error('The program on this cluster emits no ChangeRecord events: upgrade it to this build before seeding.');
  }
  await step('Register mint, freeze and thaw policies', policiesA, [payer]);
  await step('Register burn, pause and resume policies; seal', policiesB, [payer]);
  await step('Attest reserves at 10,000,000 vUSD', [await attestIx(config.publicKey, mint.publicKey, keys.attestor.publicKey, RESERVES)], [payer, signer.attestor]);

  // History.
  await step('Fast-lane mint 1,000,000 vUSD', [await executeNowIx(roles, mintTo(FAST_MINT), reserve)], [payer, signer.proposer, signer.approver]);

  // Sent without preflight so the refusal lands onchain as evidence.
  let tx = await prepare(new Transaction().add(await executeNowIx(roles, mintTo(REFUSED_MINT), reserve)), payerKp.publicKey);
  for (const s of [payer, signer.proposer, signer.approver]) [tx] = await s.sign([tx]);
  const refused = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const res = await connection.confirmTransaction(refused, 'confirmed');
  const why = errorName(await logsOf(refused));
  if (!res.value.err || why !== 'OverReserves') throw new Error(`Expected the 80M mint to fail with OverReserves, got ${why} (${refused})`);
  log.push(['Refused 80,000,000 vUSD mint (OverReserves)', refused]);
  console.log(`  ✓ Refused 80,000,000 vUSD mint (OverReserves)  ${refused}`);

  // queueIx reads proposal_count, so these must run one after the other.
  await step('Queue 3,000,000 vUSD mint (Params, 120s)', [await queueIx(roles, mintTo(QUEUED_MINT))], [payer, signer.proposer, signer.approver]);
  const outsider = Keypair.generate().publicKey;
  const setAuth = createSetAuthorityInstruction(mint.publicKey, authority, AuthorityType.MintTokens, outsider, [], TOKEN_2022);
  await step('Queue SetAuthority to an outside wallet (Max, 300s)', [await queueIx(roles, setAuth)], [payer, signer.proposer, signer.approver]);
  const reasonHash = createHash('sha256').update(VETO_REASON).digest();
  await step(
    'Guardian vetoes the SetAuthority proposal',
    [await vetoIx(config.publicKey, keys.guardian.publicKey, pda.proposal(config.publicKey, 1), reasonHash)],
    [payer, signer.guardian],
  );

  const pk = (k: PublicKey) => k.toBase58();
  console.log(`
VITE_CONFIG=${pk(config.publicKey)}

Mint (vUSD)      ${pk(mint.publicKey)}  ${link('address', pk(mint.publicKey))}
Config           ${pk(config.publicKey)}  ${link('address', pk(config.publicKey))}
Authority PDA    ${pk(authority)}
Reserve          ${pk(reserve)}
Treasury         ${pk(treasury)}
${ROLES.map((r) => `${r.padEnd(16)} ${pk(keys[r].publicKey)}  (${join(KEY_DIR, `${r}.json`)})`).join('\n')}
Veto reason      sha256 ${reasonHash.toString('hex')}
                 "${VETO_REASON}"

Transactions
${log.map(([label, sig]) => `  ${label}\n    ${link('tx', sig)}`).join('\n')}

Proposal #0 (3,000,000 vUSD) can be executed from the console's Operate page after ${DELAYS[1]}s.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
