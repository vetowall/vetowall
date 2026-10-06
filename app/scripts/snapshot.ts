// Reads the demo issuer from chain and writes it to src/baked.json, so the
// published console can paint real data at once and then refresh by itself.
//
//   VITE_RPC_URL=<keyed devnet rpc> VITE_CONFIG=<config> npm run snapshot
//
// This is what keeps the RPC key out of the public bundle. The Pages build
// runs this step in Node with the keyed URL, then builds the site without it,
// so the browser only ever talks to the public devnet endpoint. That endpoint
// is rate limited and a first load through it takes about 25 seconds, which
// is why the first paint comes from this file.
import { writeFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { loadSnapshot } from '../src/vetowall';

const config = process.env.VITE_CONFIG;
if (!config) {
  console.log('VITE_CONFIG is not set; leaving src/baked.json as it is.');
  process.exit(0);
}
const snap = await loadSnapshot(new PublicKey(config));
if (!snap) throw new Error(`config ${config} not found on chain`);
writeFileSync(new URL('../src/baked.json', import.meta.url), JSON.stringify(snap));
console.log(`baked ${snap.deployment.symbol}: ${snap.actions.length} actions, supply ${snap.supply}`);
