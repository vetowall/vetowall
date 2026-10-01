# Vetowall issuer console

A web console for an issuer whose Token-2022 authorities are held by Vetowall. Four pages:

| Page | What it shows |
|---|---|
| Launch | Creates a mint (metadata, permanent delegate, pausable, freeze, close) with every authority set to the Vetowall PDA in one transaction, then the config, policy pack, reserve and seal. Shows "god keys: 0" by reading the mint |
| Operate | Maker-checker mint: propose, approve, then `execute_now` (fast lane) or `queue` (timelock). Reserve attestation. Proposals timeline with countdowns and an Execute button once a timelock ends |
| Comply | Freeze via policy (queued, Params class). Change-control report as CSV, JSON or print, each column mapped to a control in the OCC's proposed 12 CFR 15.13. Rows come from chain: Proposal accounts plus the `ChangeRecord` events in the config's (and reserve's) transaction history |
| Guardian | Decisions feed from `GET $VITE_GUARDIAN_URL/decisions`, with the SHA-256 of each explanation re-checked in the browser. Manual pause, veto and queue-resume with the demo guardian key |

With no live deployment the console shows seeded demo data (badged "Demo data"), including a vetoed 80M unbacked mint and a refused 300T fat-finger.

## Run

```sh
npm ci
npm run dev      # http://localhost:5173
npm test         # report export and record mapping (node:test)
npm run build    # type-check + production build into dist/
```

Optional env (`.env.local` or repository variables for the Pages build):

| Variable | Default | Purpose |
|---|---|---|
| `VITE_CONFIG` | none | Shared devnet Vetowall config to show; its mint is read from the config's Reserve account |
| `VITE_GUARDIAN_URL` | none | Guardian service base URL; falls back to seeded decisions |
| `VITE_RPC_URL` | `https://api.devnet.solana.com` | Devnet RPC |

A token launched from this browser is remembered in `localStorage` and takes precedence over `VITE_CONFIG`.

## Seeding the live devnet demo

```sh
npm run seed:devnet                                     # devnet (needs the upgraded program)
VITE_RPC_URL=http://127.0.0.1:8899 npm run seed:devnet  # or a local solana-test-validator
```

`scripts/seed-devnet.ts` (run with `tsx`, reusing `src/` modules) pays from `~/.config/solana/id.json` and:

- creates or reuses role keys in `~/worldsfair/keys/devnet-demo/{proposer,approver,guardian,attestor}.json` (chmod 600, outside the repo) and tops each up with a little SOL;
- launches a Token-2022 "vUSD" mint with every authority on the Vetowall PDA (the Launch page's transaction), delays 0/120/180/300 s, the issuer policy pack with a 5,000,000 vUSD/day cap, then seals and attests 10,000,000 vUSD;
- leaves history: a 1,000,000 fast-lane mint, a refused 80,000,000 mint (`OverReserves`, sent without preflight so it lands), a queued 3,000,000 mint, and a queued SetAuthority that the guardian vetoes with a reason hash.

It prints `VITE_CONFIG=<config>`, the mint, role keys and explorer links. Each run makes a new config and mint, so it is safe to re-run. It stops early if the cluster's program emits no `ChangeRecord` events (not yet upgraded).

## Keys

- **Connect Phantom**: the wallet is admin, fee payer and proposer (maker). The approver (checker), guardian and attestor are demo keys.
- **Use demo keys**: four burner keypairs kept in `localStorage`. Devnet only. Fund the proposer with the Airdrop button or faucet.solana.com.

## Layout

| File | Role |
|---|---|
| `src/vetowall.ts` | Every program call. The only module that reads the IDL |
| `src/idl/vetowall.json` | Copy of `idl/vetowall.json` at the repo root. Refresh it when the program changes |
| `src/token.ts` | Token-2022 launch transaction and mint reads (`@solana/spl-token`) |
| `src/chain.ts` | Connection, wallet-standard and burner signers, sending, error decoding |
| `src/records.ts` | Maps `ChangeRecord` events and refused fast-lane transactions to timeline/report actions. Pure, tested in `records.test.ts` |
| `src/report.ts` | Change-control report rows, CSV and JSON. Pure, tested in `report.test.ts` |
| `src/demo.ts` | Seeded demo data |

Libraries: `@solana/web3.js` 1.x, `@anchor-lang/core` (Anchor 1.x TS client, which still targets web3.js 1.x), `@solana/spl-token` 0.4 (has Pausable, permanent delegate and metadata pointer), `@wallet-standard/app`.

## Where the history comes from

Every privileged instruction emits a `ChangeRecord` event (docs/SPEC.md, Events). The console reads `getSignaturesForAddress` for the config and its Reserve (`attest_reserve` doesn't take the config), fetches each transaction once, and decodes the events with the IDL's event coder. Timelocked actions come from their Proposal accounts, whose `executed_at` gives the executed time. A fast-lane mint the program refuses is sent with `skipPreflight`, so the failed transaction lands and shows up as a refused row. Nothing is kept in browser storage except the burner keys and the last launched config.

Limit: the newest 1,000 signatures per address are read.
