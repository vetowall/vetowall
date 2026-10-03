// Puts an existing Token-2022 mint under Vetowall: creates and seals a config
// with the issuer policy pack, then hands every authority our key holds to
// the Vetowall PDA.
//
//   PROPOSER=<pubkey> APPROVER=<pubkey> GUARDIAN=<pubkey> ATTESTOR=<pubkey> \
//     npm run adopt -- <mint>          # prints the plan, signs nothing
//   ... npm run adopt -- <mint> --yes  # does it
//
// KEYPAIR (default ~/.config/solana/id.json) pays, is the config admin until
// seal, and must be the current holder of the authorities to hand over.
// Optional: DAILY_CAP (whole tokens, default 1000000; 0 switches the fast
// lane off), DELAYS (seconds for Safe,Params,Authority,Max; default
// 0,120,180,300, the devnet demo values), MAX_AGE (reserve attestation max
// age in seconds, default 86400), VITE_RPC_URL.
//
// The handover is one-way: afterwards an authority only leaves Vetowall
// through a queued SetAuthority that waits out the Max delay. That is why a
// run without --yes sends nothing, and why a handover that would leave any
// authority outside Vetowall is refused unless --partial is passed.
//
// This file only does I/O. Every decision (what is valid, what moves, what is
// refused) lives in ../src/adopt.ts and is tested in ../src/adopt.test.ts.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { createSetAuthorityInstruction, getExtensionTypes, getMint } from '@solana/spl-token';
import { createUpdateAuthorityInstruction } from '@solana/spl-token-metadata';
import { AdoptError, capInBaseUnits, parseOptions, planHandover, requireComplete, type Plan } from '../src/adopt';
import { RPC_URL, connection, explorer, keypairSigner, run, type Signer } from '../src/chain';
import { TOKEN_2022, readMint } from '../src/token';
import { isDeployed, pda, setupIxs } from '../src/vetowall';

/**
 * Loads a Solana CLI keypair file (a JSON array of 64 bytes).
 *
 * We name the path in the error and nothing else. A JSON parse error quotes
 * the text around the bad character, and in this file that text is the secret
 * key, so the underlying message must not reach the terminal or a CI log.
 */
function loadKeypair(path: string): Keypair {
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  } catch {
    throw new Error(`Can't read a keypair from ${path}. Set KEYPAIR to a Solana CLI keypair file.`);
  }
}

/** Builds one instruction per authority in the plan, each moving it from `holder` to the Vetowall PDA. */
function handoverIxs(plan: Plan, mint: PublicKey, holder: PublicKey, authority: PublicKey): TransactionInstruction[] {
  return plan.handover.map((a) =>
    a.move === 'metadata'
      ? createUpdateAuthorityInstruction({ programId: TOKEN_2022, metadata: mint, oldAuthority: holder, newAuthority: authority })
      : createSetAuthorityInstruction(mint, holder, a.move, authority, [], TOKEN_2022),
  );
}

/** Prints what a run with --yes would do, including everything it would leave outside Vetowall. */
function printPlan(plan: Plan, symbol: string, mint: PublicKey, config: PublicKey, authority: PublicKey, delays: number[], capTokens: bigint) {
  console.log(`RPC ${RPC_URL}\n${symbol}  ${mint.toBase58()}\nConfig ${config.toBase58()}  Authority PDA ${authority.toBase58()}`);
  console.log(`Delays Safe/Params/Authority/Max: ${delays.join('/')} s   Daily mint cap: ${capTokens} ${symbol}`);
  console.log(`\nHand over to Vetowall:\n${plan.handover.map((a) => `  ${a.name}`).join('\n')}`);
  if (plan.foreign.length) console.log(`\nHeld by another key, so they stay god keys:\n${plan.foreign.map((a) => `  ${a.name}: ${a.holder}`).join('\n')}`);
  if (plan.unhandled.length) console.log(`\nExtensions whose authorities this script doesn't read or move:\n  ${plan.unhandled.join(', ')}`);
}

async function main() {
  const opts = parseOptions(process.argv.slice(2), process.env);
  // Mainnet and any cluster without the program stop here, before we read a key file.
  if (!(await isDeployed())) throw new Error(`Vetowall isn't deployed on ${RPC_URL}.`);
  const kp = loadKeypair(opts.keypairPath ?? join(homedir(), '.config', 'solana', 'id.json'));
  const me = kp.publicKey;
  const payer = keypairSigner('payer', kp);

  // The policy pack only covers Token-2022, so anything else stops here. The
  // spl-token errors for a missing account or a wrong owner carry a name and
  // an empty message, so we say what we looked for and keep the name.
  const info = await readMint(connection, opts.mint).catch((e: Error) => {
    throw new Error(`${opts.mint.toBase58()} isn't a readable Token-2022 mint on ${RPC_URL} (${e.name}${e.message ? `: ${e.message}` : ''}).`);
  });
  const extensions = getExtensionTypes((await getMint(connection, opts.mint, 'confirmed', TOKEN_2022)).tlvData);
  const plan = planHandover(info.authorities, extensions, me);
  const dailyCap = capInBaseUnits(opts.dailyCapTokens, info.decimals);
  const config = Keypair.generate();
  const authority = pda.authority(config.publicKey);

  printPlan(plan, info.symbol, opts.mint, config.publicKey, authority, opts.delays, opts.dailyCapTokens);
  if (!opts.send) {
    console.log('\nDry run: nothing was signed. Add --yes to send. The handover can only be undone through the Max timelock.');
    // The dry run applies the same refusal as a real run, so its exit status tells a script whether --yes would go through.
    requireComplete(plan, opts.partial);
    return;
  }
  requireComplete(plan, opts.partial);

  const step = async (label: string, ixs: TransactionInstruction[], extra: Signer[] = []) => {
    const sig = await run(new Transaction().add(...ixs), [payer, ...extra]);
    console.log(`  ✓ ${label}  ${explorer('tx', sig)}`);
  };

  // The config is built and sealed before any authority moves. If we moved the
  // keys first and a policy transaction then failed, the mint would sit on a
  // PDA whose every instruction defaults to the Max class with no fast lane,
  // and the admin could still rewrite the policies without a timelock.
  const [init, policiesA, policiesB] = await setupIxs({ admin: me, config: config.publicKey, mint: opts.mint, ...opts.roles, delays: opts.delays, dailyCap, maxAge: opts.maxAge });
  try {
    await step('Initialize config and reserve', init, [keypairSigner('config', config)]);
    await step('Register mint, freeze and thaw policies', policiesA);
    await step('Register burn, pause and resume policies; seal', policiesB);
    // One transaction, so the authorities move together or not at all. If
    // another party changed an authority since we read the mint, Token-2022
    // rejects that instruction and the whole handover fails.
    await step(`Hand ${plan.handover.length} authorities to the Vetowall PDA`, handoverIxs(plan, opts.mint, me, authority));
  } catch (e) {
    // Every step above leaves the mint as it was: the setup steps never touch it, and the handover is atomic.
    throw new Error(`${(e as Error).message}\nNo authority has moved. Config ${config.publicKey.toBase58()} is unused; run again to start a new one.`);
  }

  // We read the mint back instead of trusting our own transaction, and we only
  // claim full coverage when the chain shows it and the plan had no gaps.
  const after = await readMint(connection, opts.mint);
  const pdaKey = authority.toBase58();
  const missed = plan.handover.filter((a) => after.authorities.find((b) => b.name === a.name)?.holder !== pdaKey);
  if (missed.length) throw new Error(`The handover landed, but these are not on the Vetowall PDA: ${missed.map((a) => a.name).join(', ')}.`);
  const outside = after.authorities.filter((a) => a.holder && a.holder !== pdaKey).map((a) => a.name);
  const gaps = [...outside, ...plan.unhandled.map((e) => `${e} extension`)];
  console.log(gaps.length ? `\nMoved ${plan.handover.length} authorities. Still outside Vetowall: ${gaps.join(', ')}.` : '\nEvery authority on the mint is now held by Vetowall.');
  console.log(`VITE_CONFIG=${config.publicKey.toBase58()}\nNext: the attestor attests reserves, then mint from the console's Operate page.`);
}

main().catch((e) => {
  // A refusal is expected output, so it gets one line. Anything else is a failure we didn't plan for; keep its message too.
  console.error(e instanceof AdoptError ? `Refused: ${e.message}` : ((e as Error)?.message ?? e));
  process.exit(1);
});
