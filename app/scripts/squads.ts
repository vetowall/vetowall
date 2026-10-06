// Shows a Squads v4 multisig vault acting as the approver of a Vetowall
// config on devnet. Squads decides who can sign; Vetowall decides what a
// signature is allowed to do, and when.
//
//   VITE_RPC_URL=<devnet rpc> npm run squads
//
// One run creates a 2-of-3 multisig, a Token-2022 mint and a sealed Vetowall
// config (proposer: a plain key, approver: the multisig's vault PDA, guardian
// and attestor: their own keys), hands the mint's authorities to the Vetowall
// PDA the way scripts/adopt.ts does, and then sends three transactions:
//
//   (a) a mint within the daily cap, wrapped in a vault transaction that two
//       members approved. It lands.
//   (b) the same mint sent by the proposer alone. Vetowall refuses it
//       (`NotApprover`).
//   (c) a mint over the daily cap, again fully approved by the vault. Vetowall
//       refuses it (`OverCap`). The vault then approves queueing it, and it
//       sits in the timelock where the guardian can veto it.
//
// How the two signatures meet in one instruction: `execute_now` and `queue`
// need the proposer and the approver as signers of the same instruction. A
// vault PDA can only sign through a CPI from the Squads program, so the
// instruction is stored in a vault transaction. When a member executes it,
// Squads signs for the vault, and every other signer the stored message names
// must be a signer of the outer transaction (`executable_transaction_message.rs`
// in Squads-Protocol/v4: `require!(account_info.is_signer, InvalidAccount)`
// for each message signer that isn't the vault or an ephemeral PDA). Squads
// then passes that signer flag on to the inner instruction. So the proposer
// co-signs the execute transaction, and Vetowall sees both.
//
// The payer is ~/.config/solana/id.json (config admin until seal, and fee and
// rent payer throughout). Member and role keys are created once in
// ~/worldsfair/keys/devnet-squads/ and reused. Each run makes a new multisig,
// mint and config, so re-running is safe. A run costs about 0.07 SOL.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionMessage, type TransactionInstruction } from '@solana/web3.js';
import { getExtensionTypes, getMint } from '@solana/spl-token';
import * as multisig from '@sqds/multisig';
import { handoverIxs, planHandover, requireComplete } from '../src/adopt';
import { RPC_URL, connection, explorer, keypairSigner, prepare, run, type Signer } from '../src/chain';
import { errorName } from '../src/records';
import { TOKEN_2022, ata, launchTx, mintToIx, readMint } from '../src/token';
import { attestIx, executeNowIx, isDeployed, pda, queueIx, setupIxs } from '../src/vetowall';

const DECIMALS = 6;
const tokens = (n: number) => BigInt(n) * 10n ** BigInt(DECIMALS);
/** Timelocks in seconds for Safe, Params, Authority, Max: the devnet demo values from docs/SPEC.md. */
const DELAYS: [number, number, number, number] = [0, 120, 180, 300];
const DAILY_CAP = tokens(1_000_000);
/** Above the cap plus both mints, so the over-cap mint fails on the cap and not on reserves (reserves are checked first). */
const RESERVES = tokens(10_000_000);
const ROUTINE_MINT = tokens(250_000);
const OVER_CAP_MINT = tokens(2_000_000);
const KEY_DIR = join(homedir(), 'worldsfair', 'keys', 'devnet-squads');
/**
 * The proposer pays the rent of the Proposal account that `queue` creates
 * (about 0.013 SOL at its fixed maximum size), so it is the only fresh key
 * that needs a balance. Every other fee and rent comes from the payer.
 */
const PROPOSER_LAMPORTS = 0.03 * LAMPORTS_PER_SOL;

/**
 * Loads a keypair from `KEY_DIR`, creating it on first use.
 *
 * The files stay outside the repository and are written 0600. We reuse them
 * across runs so the multisig members and role keys stay the same addresses.
 */
function key(name: string): Keypair {
  const path = join(KEY_DIR, `${name}.json`);
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  chmodSync(path, 0o600); // in case the umask widened it
  return kp;
}

/** Every transaction the run sent, in order, for the summary. */
const sent: [string, string][] = [];

/** Sends one transaction that must succeed, and records its signature. The first signer pays. */
async function step(label: string, ixs: TransactionInstruction[], signers: Signer[]): Promise<string> {
  const sig = await run(new Transaction().add(...ixs), signers);
  sent.push([label, sig]);
  console.log(`  ok       ${label}\n           ${explorer('tx', sig)}`);
  return sig;
}

/**
 * Sends one transaction that Vetowall must refuse with the error `expected`.
 *
 * We skip preflight so the failed transaction lands and the refusal is an
 * onchain record anyone can open. If it succeeds, or fails for another
 * reason, the demo's claim would be false, so we stop the run.
 */
async function refused(label: string, expected: string, ixs: TransactionInstruction[], signers: Signer[]): Promise<string> {
  let tx = await prepare(new Transaction().add(...ixs), signers[0].publicKey);
  for (const s of signers) [tx] = await s.sign([tx]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const res = await connection.confirmTransaction(sig, 'confirmed');
  const logs = (await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }))?.meta?.logMessages ?? [];
  const why = errorName(logs);
  if (!res.value.err || why !== expected) throw new Error(`${label}: expected Vetowall to refuse with ${expected}, got ${res.value.err ? why : 'success'} (${sig})`);
  sent.push([`${label} (${expected})`, sig]);
  console.log(`  refused  ${label}: ${expected}\n           ${explorer('tx', sig)}`);
  return sig;
}

async function main() {
  if (/mainnet/i.test(RPC_URL)) throw new Error('Refusing to run against mainnet: devnet only.');
  if (!(await isDeployed())) throw new Error("Vetowall isn't deployed on this cluster.");
  const squads = multisig.PROGRAM_ID;
  if (!(await connection.getAccountInfo(squads))?.executable) throw new Error(`Squads v4 (${squads.toBase58()}) isn't deployed on this cluster.`);

  const payerKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
  const me = payerKp.publicKey;
  const payer = keypairSigner('payer', payerKp);
  const startBalance = await connection.getBalance(me);
  // We print the host only: an RPC URL usually carries an API key.
  console.log(`RPC ${new URL(RPC_URL).host}\nPayer ${me.toBase58()} (${startBalance / LAMPORTS_PER_SOL} SOL)\n`);

  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const members = ['member1', 'member2', 'member3'].map(key);
  const [m1, m2] = members.map((kp, i) => keypairSigner(`member${i + 1}`, kp));
  const proposerKp = key('proposer');
  const proposer = keypairSigner('proposer', proposerKp);
  const guardian = key('guardian').publicKey;
  const attestorKp = key('attestor');

  // 1. The multisig. `createKey` only seeds the multisig address, so a fresh
  // one per run gives a fresh multisig. With no config authority the multisig
  // can only be changed by its own members. Vault 0 is the default vault.
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, multisig.getProgramConfigPda({})[0]);
  console.log('Squads');
  await step('Create a 2-of-3 multisig', [
    multisig.instructions.multisigCreateV2({
      treasury: programConfig.treasury, creator: me, multisigPda, configAuthority: null, threshold: 2, timeLock: 0,
      members: members.map((kp) => ({ key: kp.publicKey, permissions: multisig.types.Permissions.all() })),
      createKey: createKey.publicKey, rentCollector: null,
    }),
  ], [payer, keypairSigner('createKey', createKey)]);

  // 2. A mint whose authorities all start on the payer, as an issuer's
  // existing mint would, and the proposer's rent money.
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const configKp = Keypair.generate();
  const config = configKp.publicKey;
  const authority = pda.authority(config);
  const reserve = pda.reserve(config, mint);
  const treasury = ata(me, mint);
  console.log('\nMint and Vetowall config');
  const launch = await launchTx(connection, me, mintKp, me, { name: 'Squads Demo USD', symbol: 'sqUSD', uri: '', decimals: DECIMALS });
  const topUp = PROPOSER_LAMPORTS - (await connection.getBalance(proposerKp.publicKey));
  if (topUp > 0) launch.add(SystemProgram.transfer({ fromPubkey: me, toPubkey: proposerKp.publicKey, lamports: topUp }));
  await step('Create the sqUSD mint, every authority on the payer', launch.instructions, [payer, keypairSigner('mint', mintKp)]);

  // 3. The same order as scripts/adopt.ts: config, policies and seal first,
  // then one transaction that moves every authority. If a setup step fails,
  // no authority has moved.
  const [init, policiesA, policiesB] = await setupIxs({
    admin: me, config, mint, proposer: proposerKp.publicKey, approver: vault, guardian, attestor: attestorKp.publicKey,
    delays: DELAYS, dailyCap: DAILY_CAP, maxAge: 86400,
  });
  await step('Initialize the config (approver = Squads vault) and reserve', init, [payer, keypairSigner('config', configKp)]);
  await step('Register mint, freeze and thaw policies', policiesA, [payer]);
  await step('Register burn, pause and resume policies; seal', policiesB, [payer]);
  const before = await readMint(connection, mint);
  const plan = planHandover(before.authorities, getExtensionTypes((await getMint(connection, mint, 'confirmed', TOKEN_2022)).tlvData), me);
  requireComplete(plan, false);
  await step(`Hand ${plan.handover.length} authorities to the Vetowall PDA`, handoverIxs(plan, mint, me, authority), [payer]);
  const outside = (await readMint(connection, mint)).authorities.filter((a) => a.holder !== authority.toBase58()).map((a) => a.name);
  if (outside.length) throw new Error(`Not on the Vetowall PDA after the handover: ${outside.join(', ')}.`);
  await step('Attest reserves at 10,000,000 sqUSD', [await attestIx(config, mint, attestorKp.publicKey, RESERVES)], [payer, keypairSigner('attestor', attestorKp)]);

  const roles = { config, proposer: proposerKp.publicKey, approver: vault };
  const mintTo = (amount: bigint) => mintToIx(mint, treasury, authority, amount);
  let txIndex = 0n;

  /**
   * Stores one Vetowall instruction as a Squads vault transaction, has member
   * 1 propose it and members 1 and 2 approve it, and returns the instruction
   * that executes it.
   *
   * After this the vault's approval exists onchain but nothing has run: the
   * execute instruction still needs a member and, because the stored message
   * names the proposer as a signer, the proposer's signature too. The payer
   * pays the rent so the member keys need no balance.
   */
  async function vaultApproves(label: string, ix: TransactionInstruction): Promise<TransactionInstruction> {
    const transactionIndex = ++txIndex;
    const { blockhash } = await connection.getLatestBlockhash();
    const member = m1.publicKey;
    await step(`${label}: member 1 proposes a vault transaction`, [
      multisig.instructions.vaultTransactionCreate({
        multisigPda, transactionIndex, creator: member, rentPayer: me, vaultIndex: 0, ephemeralSigners: 0,
        transactionMessage: new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: [ix] }),
      }),
      multisig.instructions.proposalCreate({ multisigPda, transactionIndex, creator: member, rentPayer: me }),
    ], [payer, m1]);
    await step(`${label}: members 1 and 2 approve (2 of 3)`, [
      multisig.instructions.proposalApprove({ multisigPda, transactionIndex, member }),
      multisig.instructions.proposalApprove({ multisigPda, transactionIndex, member: m2.publicKey }),
    ], [payer, m1, m2]);
    return (await multisig.instructions.vaultTransactionExecute({ connection, multisigPda, transactionIndex, member })).instruction;
  }
  const supply = async () => (await readMint(connection, mint)).supply;

  // (a) Proposer and vault together, within the cap.
  console.log('\n(a) Routine mint of 250,000 sqUSD, approved by the vault');
  const routine = await executeNowIx(roles, mintTo(ROUTINE_MINT), reserve);
  const a = await step('Execute: vault (via Squads) and proposer sign execute_now', [await vaultApproves('Mint 250,000', routine)], [payer, m1, proposer]);
  if ((await supply()) !== ROUTINE_MINT) throw new Error('The routine mint landed but the supply is not 250,000 sqUSD.');

  // (b) The proposer alone. The approver slot is left empty, which is the
  // most the proposer can do without the vault: it can't sign for a PDA.
  console.log('\n(b) The same mint without the vault');
  const b = await refused('Proposer alone sends execute_now', 'NotApprover', [await executeNowIx({ ...roles, approver: null }, mintTo(ROUTINE_MINT), reserve)], [payer, proposer]);

  // (c) Both signatures again, but over the cap. The vault's approval is
  // valid and Squads executes it; the refusal comes from Vetowall's policy.
  console.log('\n(c) Mint of 2,000,000 sqUSD, over the 1,000,000 daily cap, approved by the vault');
  const overCap = await vaultApproves('Mint 2,000,000', await executeNowIx(roles, mintTo(OVER_CAP_MINT), reserve));
  const c = await refused('Execute: vault and proposer sign execute_now', 'OverCap', [overCap], [payer, m1, proposer]);
  if ((await supply()) !== ROUTINE_MINT) throw new Error('The supply changed after a refused mint.');
  // The only way left is the timelock. `queue` needs the same two signers.
  const queueSig = await step('Execute: vault and proposer sign queue', [await vaultApproves('Queue 2,000,000', await queueIx(roles, mintTo(OVER_CAP_MINT)))], [payer, m1, proposer]);
  const proposal = pda.proposal(config, 0);

  const pk = (k: PublicKey) => k.toBase58();
  const spent = (startBalance - (await connection.getBalance(me))) / LAMPORTS_PER_SOL;
  console.log(`
Summary
  Vault role       approver (checker). The proposer (maker) is a plain key.
  Multisig         ${pk(multisigPda)}  ${explorer('address', pk(multisigPda))}
  Vault (approver) ${pk(vault)}  ${explorer('address', pk(vault))}
  Members (2 of 3) ${members.map((kp) => pk(kp.publicKey)).join(' ')}
  Config           ${pk(config)}  ${explorer('address', pk(config))}
  Mint (sqUSD)     ${pk(mint)}  ${explorer('address', pk(mint))}
  Authority PDA    ${pk(authority)}
  Proposer         ${pk(proposerKp.publicKey)}
  Guardian         ${pk(guardian)}
  Attestor         ${pk(attestorKp.publicKey)}
  Keys             ${KEY_DIR}

  (a) landed       ${explorer('tx', a)}
  (b) NotApprover  ${explorer('tx', b)}
  (c) OverCap      ${explorer('tx', c)}
      queued       ${explorer('tx', queueSig)}
      Proposal #0  ${pk(proposal)}: anyone can execute it after ${DELAYS[1]} s unless the guardian vetoes it.

  Supply           ${Number(await supply()) / 10 ** DECIMALS} sqUSD
  Payer spent      ${spent.toFixed(6)} SOL (${sent.length} transactions)
  Console          https://vetowall.github.io/vetowall/?config=${pk(config)}`);
}

main().catch((e) => {
  console.error((e as Error)?.message ?? e);
  process.exit(1);
});
