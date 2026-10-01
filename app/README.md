# Vetowall issuer console

A web console for an issuer whose Token-2022 authorities are held by Vetowall. Four pages:

| Page | What it shows |
|---|---|
| Launch | Creates a mint (metadata, permanent delegate, pausable, freeze, close) with every authority set to the Vetowall PDA in one transaction, then the config, policy pack, reserve and seal. Shows "god keys: 0" by reading the mint |
| Operate | Maker-checker mint: propose, approve, then `execute_now` (fast lane) or `queue` (timelock). Reserve attestation. Proposals timeline with countdowns and an Execute button once a timelock ends |
| Comply | Freeze via policy (queued, Params class). Change-control report as CSV, JSON or print, each column mapped to a control in the OCC's proposed 12 CFR 15.13 |
| Guardian | Decisions feed from `GET $VITE_GUARDIAN_URL/decisions`, with the SHA-256 of each explanation re-checked in the browser. Manual pause, veto and queue-resume with the demo guardian key |

With no live deployment the console shows seeded demo data (badged "Demo data"), including a vetoed 80M unbacked mint and a refused 300T fat-finger.

## Run

```sh
npm ci
npm run dev      # http://localhost:5173
npm test         # report export (node:test)
npm run build    # type-check + production build into dist/
```

Optional env (`.env.local` or repository variables for the Pages build):

| Variable | Default | Purpose |
|---|---|---|
| `VITE_CONFIG` | none | Shared devnet Vetowall config to show; its mint is read from the config's Reserve account |
| `VITE_GUARDIAN_URL` | none | Guardian service base URL; falls back to seeded decisions |
| `VITE_RPC_URL` | `https://api.devnet.solana.com` | Devnet RPC |

A token launched from this browser is remembered in `localStorage` and takes precedence over `VITE_CONFIG`.

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
| `src/report.ts` | Change-control report rows, CSV and JSON. Pure, tested in `report.test.ts` |
| `src/demo.ts` | Seeded demo data |

Libraries: `@solana/web3.js` 1.x, `@anchor-lang/core` (Anchor 1.x TS client, which still targets web3.js 1.x), `@solana/spl-token` 0.4 (has Pausable, permanent delegate and metadata pointer), `@wallet-standard/app`.

## Known limits

- `execute_now` and `guardian_execute` don't create a Proposal account, so fast-lane and guardian actions in the live timeline and report come from a log kept in this browser. Reading them from transaction history would make the report complete for every viewer.
- Executed time isn't stored onchain, so the report gives the earliest effective time (`eta`).
