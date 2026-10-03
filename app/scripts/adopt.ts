// Puts an existing Token-2022 mint under Vetowall: creates and seals a config
// with the issuer policy pack, then hands every authority your key holds to
// the Vetowall PDA.
//
//   PROPOSER=<pubkey> APPROVER=<pubkey> GUARDIAN=<pubkey> ATTESTOR=<pubkey> \
//     npm run adopt -- <mint>          # prints the plan, sends nothing
//   ... npm run adopt -- <mint> --yes  # does it
//
// KEYPAIR (default ~/.config/solana/id.json) pays, is the config admin until
// seal, and must be the current holder of the authorities to hand over.
// Optional: DAILY_CAP (whole tokens, default 1000000), DELAYS (seconds for
// Safe,Params,Authority,Max; default 0,120,180,300, the devnet demo values),
// MAX_AGE (reserve attestation max age in seconds, default 86400).
//
// The handover is one-way: afterwards an authority only leaves Vetowall
// through a queued SetAuthority that waits out the Max delay.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { AuthorityType, ExtensionType, createSetAuthorityInstruction, getExtensionTypes, getMint } from '@solana/spl-token';
import { createUpdateAuthorityInstruction } from '@solana/spl-token-metadata';
import { RPC_URL, connection, explorer, keypairSigner, run } from '../src/chain';
import { TOKEN_2022, readMint } from '../src/token';
import { isDeployed, pda, setupIxs } from '../src/vetowall';

/** `readMint` names → the SetAuthority type. Metadata update has its own instruction. */
const TYPES: Record<string, AuthorityType> = {
  Mint: AuthorityType.MintTokens,
  Freeze: AuthorityType.FreezeAccount,
  'Permanent delegate': AuthorityType.PermanentDelegate,
  Pause: AuthorityType.PausableConfig,
  'Metadata pointer': AuthorityType.MetadataPointer,
  'Close mint': AuthorityType.CloseMint,
};
/** Extensions whose authorities `readMint` covers (or that have none). */
const COVERED = [
  ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata,
  ExtensionType.PermanentDelegate,
  ExtensionType.PausableConfig,
  ExtensionType.MintCloseAuthority,
];

const args = process.argv.slice(2);
const go = args.includes('--yes');
const mintArg = args.find((a) => !a.startsWith('--'));
const key = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} to a public key.`);
  return new PublicKey(v);
};

async function main() {
  if (!mintArg) throw new Error('Usage: npm run adopt -- <mint> [--yes]');
  if (!(await isDeployed())) throw new Error(`Vetowall isn't deployed on ${RPC_URL}.`);
  const mint = new PublicKey(mintArg);
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(process.env.KEYPAIR || join(homedir(), '.config', 'solana', 'id.json'), 'utf8'))),
  );
  const me = kp.publicKey;
  const payer = keypairSigner('payer', kp);
  const roles = { proposer: key('PROPOSER'), approver: key('APPROVER'), guardian: key('GUARDIAN'), attestor: key('ATTESTOR') };
  const delays = (process.env.DELAYS || '0,120,180,300').split(',').map(Number) as [number, number, number, number];
  if (delays.length !== 4 || delays.some((d) => !Number.isInteger(d) || d < 0)) throw new Error('DELAYS must be four whole seconds: Safe,Params,Authority,Max');

  const info = await readMint(connection, mint); // throws unless the mint is Token-2022
  const dailyCap = BigInt(process.env.DAILY_CAP || 1_000_000) * 10n ** BigInt(info.decimals);
  const config = Keypair.generate();
  const authority = pda.authority(config.publicKey);

  const mine = info.authorities.filter((a) => a.holder === me.toBase58());
  const others = info.authorities.filter((a) => a.holder && a.holder !== me.toBase58());
  if (!mine.length) throw new Error(`${me.toBase58()} holds no authority on ${info.symbol} (${mint.toBase58()}).`);
  const uncovered = getExtensionTypes((await getMint(connection, mint, 'confirmed', TOKEN_2022)).tlvData).filter((e) => !COVERED.includes(e));

  console.log(`RPC ${RPC_URL}\n${info.symbol}  ${mint.toBase58()}\nConfig ${config.publicKey.toBase58()}  Authority PDA ${authority.toBase58()}`);
  console.log(`Delays Safe/Params/Authority/Max: ${delays.join('/')} s   Daily mint cap: ${process.env.DAILY_CAP || 1_000_000} ${info.symbol}`);
  console.log(`\nHand over to Vetowall:\n${mine.map((a) => `  ${a.name}`).join('\n')}`);
  if (others.length) console.log(`\nNOT handed over (held by another key, which stays a god key):\n${others.map((a) => `  ${a.name}: ${a.holder}`).join('\n')}`);
  if (uncovered.length)
    console.log(`\nThis mint has extensions this script doesn't handle; move their authorities yourself:\n  ${uncovered.map((e) => ExtensionType[e]).join(', ')}`);
  if (!go) return console.log('\nDry run. Add --yes to send. The handover can only be undone through the Max timelock.');

  const step = async (label: string, ixs: TransactionInstruction[], extra = [] as ReturnType<typeof keypairSigner>[]) =>
    console.log(`  ✓ ${label}  ${explorer('tx', await run(new Transaction().add(...ixs), [payer, ...extra]))}`);

  // Config first, sealed, so the authorities never sit on a half-built policy.
  const [init, policiesA, policiesB] = await setupIxs({ admin: me, config: config.publicKey, mint, ...roles, delays, dailyCap, maxAge: Number(process.env.MAX_AGE || 86400) });
  await step('Initialize config and reserve', init, [keypairSigner('config', config)]);
  await step('Register mint, freeze and thaw policies', policiesA);
  await step('Register burn, pause and resume policies; seal', policiesB);
  await step(
    `Hand ${mine.length} authorities to the Vetowall PDA`,
    mine.map((a) =>
      a.name === 'Metadata update'
        ? createUpdateAuthorityInstruction({ programId: TOKEN_2022, metadata: mint, oldAuthority: me, newAuthority: authority })
        : createSetAuthorityInstruction(mint, me, TYPES[a.name], authority, [], TOKEN_2022),
    ),
  );

  const after = await readMint(connection, mint);
  const stray = after.authorities.filter((a) => a.holder && a.holder !== authority.toBase58());
  console.log(`\n${stray.length ? `${stray.length} authorities are still outside Vetowall: ${stray.map((a) => a.name).join(', ')}` : 'Every authority on the mint is now held by Vetowall.'}`);
  console.log(`VITE_CONFIG=${config.publicKey.toBase58()}\nNext: the attestor attests reserves, then mint from the console's Operate page.`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
