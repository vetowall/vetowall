// Keeps a devnet issuer's reserve attestation fresh. Run on a schedule by
// .github/workflows/attest.yml, or by hand:
//
//   VITE_CONFIG=<config> ATTESTOR_KEYPAIR="$(cat attestor.json)" npm run attest
//
// It re-affirms the amount already attested when the attestation has used
// half of its max age, and does nothing otherwise. The attestor key signs and
// pays the fee. This stands in for the custodian or auditor feed an issuer
// would run in production; it reads no bank balance.
//
// The decisions are in ../src/keeper.ts and tested in ../src/keeper.test.ts.
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { KeeperError, decide, parseKeypair } from '../src/keeper';
import { RPC_URL, connection, explorer, keypairSigner, run } from '../src/chain';
import { attestIx, readReserve } from '../src/vetowall';

/** Lamports for one signature at the base fee. We refuse below twice this, so a failed run says "fund the key" instead of a simulation error. */
const FEE = 5000;

async function main() {
  // A demo keeper has no business on mainnet: there the attestor must be the party that actually sees the reserves.
  if (/mainnet/i.test(RPC_URL)) throw new Error(`Refusing to run against ${RPC_URL}: devnet or a local validator only.`);
  if (!process.env.VITE_CONFIG) throw new Error('Set VITE_CONFIG to the Vetowall config to keep fresh.');
  const config = new PublicKey(process.env.VITE_CONFIG);
  const kp = Keypair.fromSecretKey(parseKeypair(process.env.ATTESTOR_KEYPAIR));

  const reserve = await readReserve(config);
  if (!reserve) throw new Error(`Config ${config.toBase58()} has no reserve account on ${RPC_URL}.`);
  // The cluster's clock decides staleness, but ours is within seconds of it and `decide` leaves hours of margin.
  const { attest, age } = decide({ attestor: reserve.attestor.toBase58(), updatedAt: reserve.updatedAt, maxAge: reserve.maxAge }, kp.publicKey.toBase58(), Math.floor(Date.now() / 1000));
  const hours = (age / 3600).toFixed(1);
  if (!attest) return console.log(`Fresh: attested ${hours} h ago, max age ${reserve.maxAge / 3600} h. Nothing sent.`);

  const balance = await connection.getBalance(kp.publicKey);
  if (balance < 2 * FEE) throw new Error(`The attestor ${kp.publicKey.toBase58()} has ${balance} lamports; send it devnet SOL for fees.`);
  const sig = await run(new Transaction().add(await attestIx(config, reserve.mint, kp.publicKey, reserve.amount)), [keypairSigner('attestor', kp)]);

  // We read the account back: the job's whole purpose is the new timestamp, so we don't report success on the signature alone.
  const after = await readReserve(config);
  if (!after || after.updatedAt <= reserve.updatedAt) throw new Error(`Sent ${sig}, but the reserve's timestamp did not advance.`);
  console.log(`Re-attested ${reserve.amount} base units (was ${hours} h old).  ${explorer('tx', sig)}`);
}

main().catch((e) => {
  console.error(e instanceof KeeperError ? `Refused: ${e.message}` : ((e as Error)?.message ?? e));
  process.exit(1);
});
