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
npm test         # report export, record mapping and adopt decisions (node:test)
npm run build    # type-check + production build into dist/
```

Optional env (`.env.local` or repository variables for the Pages build):

| Variable | Default | Purpose |
|---|---|---|
| `VITE_CONFIG` | none | Shared devnet Vetowall config to show; its mint is read from the config's Reserve account |
| `VITE_GUARDIAN_URL` | none | Guardian service base URL; falls back to seeded decisions |
| `VITE_RPC_URL` | `https://api.devnet.solana.com` | Devnet RPC |

A token launched from this browser is remembered in `localStorage` and takes precedence over `VITE_CONFIG`. A `?config=<pubkey>` link takes precedence over both, so any issuer's console can be shared as a URL.

## Guard an existing mint

`scripts/adopt.ts` puts a Token-2022 mint you already issued under Vetowall. It creates and seals a config with the issuer policy pack, then hands every authority your key holds (mint, freeze, permanent delegate, pause, metadata pointer, metadata update, close) to the Vetowall PDA.

```sh
export PROPOSER=<pubkey> APPROVER=<pubkey> GUARDIAN=<pubkey> ATTESTOR=<pubkey>
npm run adopt -- <mint>          # prints the plan and sends nothing
npm run adopt -- <mint> --yes    # config, policies, seal, then the handover
npm run adopt -- <mint> --yes --partial   # accept that some authority stays outside
```

- `KEYPAIR` (default `~/.config/solana/id.json`) pays and must be the current holder of the authorities. Optional: `DAILY_CAP` (whole tokens, default 1,000,000; 0 switches the fast lane off), `DELAYS` (`Safe,Params,Authority,Max` in seconds, default `0,120,180,300`), `MAX_AGE`, `VITE_RPC_URL`.
- We seal the config before any authority moves, and all authorities move in one transaction. If any step fails, no authority has moved. The handover is one-way: afterwards an authority only leaves Vetowall through a queued `SetAuthority` that waits out the `Max` delay.
- **Nothing is filled in.** A missing or malformed key, an empty or non-digit number, delays that decrease from Safe to Max, an unknown flag, or a cap that doesn't fit in a u64 is refused before anything is signed. The four roles must be four different keys: a proposer that is also the approver has no checker.
- **A partial handover is refused.** If another key holds an authority, or the mint has an extension the script doesn't read (transfer fee, transfer hook, confidential transfer and others), a god key would remain. The script lists them and exits with status 1, in a dry run too. Pass `--partial` to accept that; the final line then says what is still outside Vetowall.
- After sending, we read the mint back from chain and only report full coverage when every authority is on the PDA.
- The decisions live in `src/adopt.ts` and are tested in `src/adopt.test.ts`; `scripts/adopt.ts` only does I/O.
- It prints the config. Open `https://vetowall.github.io/vetowall/?config=<config>` to see the token in the console.

## A Squads vault as the approver

Squads decides who can sign; Vetowall decides what a signature is allowed to do, and when. `scripts/squads.ts` shows the two working together on devnet, against the deployed Squads v4 program (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`):

```sh
VITE_RPC_URL=<devnet rpc> npm run squads   # about 0.07 SOL from ~/.config/solana/id.json
```

Each run creates a 2-of-3 multisig, a Token-2022 mint and a sealed config whose **approver is the multisig's vault PDA**. The proposer is a plain key, and the guardian and attestor have their own keys. The mint's seven authorities start on the payer and are handed to the Vetowall PDA with the same plan and instructions as `scripts/adopt.ts`. Member and role keys are kept in `~/worldsfair/keys/devnet-squads/` (chmod 600) and reused. Then it sends:

| | What is sent | Result |
|---|---|---|
| (a) | `execute_now` for a 250,000 mint, stored as a vault transaction, approved by 2 of 3 members, executed with the proposer co-signing | Lands. Supply is read back as 250,000 |
| (b) | The same `execute_now` from the proposer alone | Vetowall refuses: `NotApprover` |
| (c) | `execute_now` for a 2,000,000 mint (the daily cap is 1,000,000), again approved by 2 of 3 and executed with the proposer | Vetowall refuses: `OverCap`. The vault then approves a `queue` of the same mint, which lands as Proposal #0 with the 120 s `Params` timelock, open to a guardian veto |

So a vault approval is necessary (b) but not sufficient (c): a threshold of members can't push a mint past the cap, only into the timelock.

**How both signatures reach one instruction.** `execute_now` and `queue` need the proposer and the approver as signers of the same instruction, and a vault PDA can only sign through a CPI from Squads. So the Vetowall instruction is stored in a vault transaction. At `vault_transaction_execute`, Squads signs for the vault and requires every other signer named in the stored message to be a signer of the outer transaction (`executable_transaction_message.rs` in Squads-Protocol/v4), then passes that flag to the inner instruction. The proposer therefore signs the execute transaction, next to the executing member. The program needed no change.

Limits: the script doesn't execute or veto Proposal #0. A refused attempt made through Squads (c) doesn't show up in the console's timeline, which only decodes top-level Vetowall instructions of failed transactions; the queued proposal and (a) and (b) do.

Addresses and transactions from the run of 2026-10-06 (devnet):

| | |
|---|---|
| Multisig (2 of 3) | [`DY6fpnqyj88xhhyhdyAo5RAAN846RfuC75djLBE4WK4V`](https://explorer.solana.com/address/DY6fpnqyj88xhhyhdyAo5RAAN846RfuC75djLBE4WK4V?cluster=devnet) |
| Vault (approver) | [`4hGCUQrjHWq1U4ukZ4j4XmUaTWiNXX7hkFoGFqpfuDAJ`](https://explorer.solana.com/address/4hGCUQrjHWq1U4ukZ4j4XmUaTWiNXX7hkFoGFqpfuDAJ?cluster=devnet) |
| Config | [`3xQLxkuaStKrSBnCUbbPNkUhjpJmYWjoBeH6vwzn5dGM`](https://explorer.solana.com/address/3xQLxkuaStKrSBnCUbbPNkUhjpJmYWjoBeH6vwzn5dGM?cluster=devnet) ([console](https://vetowall.github.io/vetowall/?config=3xQLxkuaStKrSBnCUbbPNkUhjpJmYWjoBeH6vwzn5dGM)) |
| Mint (sqUSD) | [`7bYUmxEKEpSe6sezbrYN8k2Ekt4FLnrb3K32f72ryb71`](https://explorer.solana.com/address/7bYUmxEKEpSe6sezbrYN8k2Ekt4FLnrb3K32f72ryb71?cluster=devnet) |
| Proposer | `4toEm6Q871cbfJ6tGKvKDNHgYg2pBdiLNA8JLkBrX4vo` |
| Guardian | `J7eoE1ThaQSitUnXtNyFqnCLTJsoR2Zq88D9VFMtqw8G` |
| (a) mint lands | [`4pcaB6Kb…gb32e`](https://explorer.solana.com/tx/4pcaB6KbQdi8RCYFjuucSe8yqAp2RDeSFkCT2a4EKPpzSV2icJCw4FxXadxi6r5t2G6STRsfwzJs9RLnVe8gb32e?cluster=devnet) (Squads `VaultTransactionExecute` → Vetowall `ExecuteNow` → Token-2022 `MintTo`) |
| (b) `NotApprover` | [`3ctXntk9…BrSFA`](https://explorer.solana.com/tx/3ctXntk9K8UB6E912UyExkWRV9zaHpuJng5bno7rkqzsDndzCN92vszWpm2rVoHN4Y5wVoHbbefXAVsBFL3BrSFA?cluster=devnet) |
| (c) `OverCap` | [`5QaqDPvk…FuJmr`](https://explorer.solana.com/tx/5QaqDPvktn7pUgYo9hQzLGXgGqrXZb9cy2pHdasK2DfP1ZGPHyqsvQuRc8jszuX8ErofhNcWuffffHyX9pFFuJmr?cluster=devnet) |
| (c) queued instead | [`kZFVm6pL…THeBv`](https://explorer.solana.com/tx/kZFVm6pLGLTeKw7X6WbRES1F5MX1YD2jfHYEysiSLfnACf5k2RuVxYvw1H51QWMQeU5NHeamdHavcvK2UqTHeBv?cluster=devnet), Proposal #0 `4m7RzMpfezj3DU3CXKj5vSZQf35JYAaGoR4u9Zdi3r7R` |

## Seeding the live devnet demo

```sh
npm run seed:devnet                                     # devnet (needs the upgraded program)
VITE_RPC_URL=http://127.0.0.1:8899 npm run seed:devnet  # or a local solana-test-validator
```

`scripts/seed-devnet.ts` (run with `tsx`, reusing `src/` modules) pays from `~/.config/solana/id.json` and:

- creates or reuses role keys in `~/worldsfair/keys/devnet-demo/{proposer,approver,guardian,attestor}.json` (chmod 600, outside the repo) and tops each up with a little SOL;
- launches a Token-2022 "vUSD" mint with every authority on the Vetowall PDA (the Launch page's transaction), delays 0/120/180/300 s, the issuer policy pack with a 5,000,000 vUSD/day cap, then seals and attests 10,000,000 vUSD;
- leaves history: a 1,000,000 fast-lane mint, a refused 80,000,000 mint (`OverReserves`, sent without preflight so it lands), a queued 4,500,000 mint (above the daily cap), and a queued SetAuthority that the guardian vetoes with a reason hash.

It prints `VITE_CONFIG=<config>`, the mint, role keys and explorer links. Each run makes a new config and mint, so it is safe to re-run. It stops early if the cluster's program emits no `ChangeRecord` events (not yet upgraded).

## Keeping the demo's reserves fresh

Vetowall refuses every mint once the reserve attestation is older than its max age, which is 24 hours on the demo issuer. `scripts/attest.ts` re-affirms the attested figure when the attestation is at least half that age, and does nothing otherwise:

```sh
VITE_CONFIG=<config> ATTESTOR_KEYPAIR="$(cat attestor.json)" npm run attest
```

`.github/workflows/attest.yml` runs it every six hours with the repository secret `ATTESTOR_KEYPAIR`. It refuses to run against mainnet, refuses a key that isn't the reserve's attestor, and never prints the key. This stands in for the custodian or auditor feed an issuer would run in production; it reads no bank balance. The decisions are in `src/keeper.ts`, tested in `src/keeper.test.ts`.

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
