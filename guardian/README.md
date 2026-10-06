# Vetowall guardian

An offchain watcher that holds Vetowall's guardian key. The program limits that key to two powers:

- `veto` a queued proposal
- run instructions registered `Safe`

This service only vetoes.

**Rules decide and the AI only explains.** Every veto comes from a deterministic rule in [`src/rules.ts`](src/rules.ts): pure functions with no I/O and no LLM. Once a rule fires, the guardian writes a short explanation. If `ANTHROPIC_API_KEY` is set, Claude rewords the rule's facts; otherwise, or if that call fails, a fixed template is used. The veto is sent either way. The guardian stores the exact text and puts its SHA-256 onchain as the veto reason. Anyone can recompute that hash from the log.

## Rules

| Rule | Fires when | Severity |
|---|---|---|
| `mint_unbacked` | `MintTo`/`MintToChecked` amount > attested reserves − supply (needs the mint's `Reserve` account) | critical |
| `mint_over_ceiling` | a mint above `MINT_CEILING_TOKENS` whole tokens | critical |
| `mint_over_average` | a mint above `MINT_MULTIPLE`× the average of the same mint's executed mints in the last 7 days | high |
| `set_authority` | SPL Token / Token-2022 `SetAuthority` | critical |
| `max_class` | any other proposal stored as class `Max` | high |
| `young_collateral` | mock_vault `list_collateral` for a mint first seen onchain less than 7 days ago | critical |
| `withdraw_limit_jump` | mock_vault `set_withdraw_limit` above 5× the current limit | high |
| `recent_role_change` | any proposal queued within 7 days of a proposer/approver/guardian change | high |

The program forbids the guardian from vetoing proposals that target Vetowall itself, so the rules skip them.

## Run

You need Node 24 or later; it runs the TypeScript directly, with no build step.

```bash
npm ci --no-audit --no-fund
cp .env.example .env        # works as copied: public devnet RPC and the live demo config
npm run dry-run             # decides and logs, sends nothing
npm start                   # vetoes for real; uncomment GUARDIAN_KEYPAIR in .env first
npm test                    # node:test unit tests
npm run typecheck
```

`--dry-run` doesn't need a keypair, and its log records have `"veto_tx": null`. If `GUARDIAN_KEYPAIR` is set, though, a dry run still reads that file and exits when it's missing. That's why `.env.example` ships the line commented out.

Check it with `curl localhost:8787/health`: `"ok":true` and a `last_poll` time mean the first poll of the config went through.

## Deploy on Render

[`render.yaml`](../render.yaml) at the repo root is a Render blueprint. It runs `npm ci` and `npm start` in `guardian/` on Node 24, and Render checks `GET /health`. It uses the smallest paid instance (0.5 CPU, 512 MB) with a 1 GB disk for the decision log. A free instance won't do: it sleeps when idle, a sleeping guardian vetoes nothing, and it can't mount a disk.

Have two things ready before you start:

- **The guardian keypair file.** This is the Solana CLI JSON (an array of 64 numbers) for the key the config names as its guardian. For the live demo config, `npm run seed:devnet` in `app/` wrote it to `~/worldsfair/keys/devnet-demo/guardian.json`. The key pays the fee for each veto (5,000 lamports), so keep about 0.01 SOL on it.
- **A keyed devnet RPC URL**, e.g. Helius: `https://devnet.helius-rpc.com/?api-key=…` from the Helius dashboard. The public devnet RPC works for a trial, but it rate-limits `getProgramAccounts`, which the guardian calls every 15 seconds.

Then:

1. In Render, **New → Blueprint**, and connect the `vetowall/vetowall` repository. Render reads `render.yaml` and asks for the two values it doesn't store in the file:
   - `RPC_URL`: the keyed devnet URL. It's required. The guardian exits at start if it's empty.
   - `ANTHROPIC_API_KEY`: optional, from console.anthropic.com. If the form won't take an empty value, put in any placeholder and delete the variable under **Environment** after step 2. Without it, explanations use the fixed template.
2. Apply the blueprint. **The first deploy fails**, and the log ends with `ENOENT: no such file or directory, open '/etc/secrets/guardian.json'`. That's expected, because a blueprint can't carry secret files.
3. Open the `vetowall-guardian` service, go to **Environment → Secret Files → Add Secret File**. Name it `guardian.json`, paste the keypair file's contents, and **Save Changes**. Saving starts a new deploy.
4. When the deploy is live, open `https://<service>.onrender.com/health`. It should show:
   - `"ok": true` and a recent `last_poll`
   - `"dry_run": false`
   - `"guardian"` equal to the config's guardian address. If it differs, the service log says `warning: Config guardian is …` and every veto will fail, so you've uploaded the wrong key.
5. Point the console at the service: set `GUARDIAN_URL` to `https://<service>.onrender.com` on Vercel (see [`web/README.md`](../web/README.md)), or `VITE_GUARDIAN_URL` for the old `app/`.

Every variable the service reads:

| Variable | Set by | Value | Meaning |
|---|---|---|---|
| `RPC_URL` | you, in step 1 | keyed devnet URL | Solana JSON-RPC endpoint. The WebSocket URL is derived from it (`https` becomes `wss`) |
| `CONFIG` | `render.yaml` | `BQodWY1t1CVVJHpGdR9UnDg3wY3gyTsBDne5y2hSfTgp` | The Vetowall config to guard (the live vUSD demo). Edit `render.yaml` for another issuer |
| `GUARDIAN_KEYPAIR` | `render.yaml` | `/etc/secrets/guardian.json` | Where Render mounts the secret file from step 3 |
| `GUARDIAN_LOG` | `render.yaml` | `/var/data/decisions.jsonl` | The decision log, on the disk so it outlives deploys |
| `NODE_VERSION` | `render.yaml` | `24` | Read by Render, not by the guardian. Node 24 runs the TypeScript sources directly |
| `PORT` | Render | Render's own | The port the HTTP server listens on. Don't set it |
| `ANTHROPIC_API_KEY` | you, optional | Anthropic API key | Claude rewords each veto's explanation |
| `PROGRAM_ID`, `WS_URL`, `POLL_MS`, `MINT_MULTIPLE`, `MINT_CEILING_TOKENS` | nobody | defaults in [`.env.example`](.env.example) | Only set these to override a default |

Two things to know about this setup. A service with a disk restarts with a few seconds of downtime on every deploy, and it can't run more than one instance. And `/health` answers 200 even when `ok` is false, so Render won't restart a guardian whose polls keep failing. Watch `ok` yourself, or with an uptime monitor that reads the body.

## Interfaces

Each decision is one JSON line appended to `GUARDIAN_LOG`, which is never rewritten:

```json
{"ts":"2026-10-01T06:00:00.000Z","proposal":"<pubkey>","id":7,"rule":"mint_unbacked","severity":"critical",
 "explanation":"Guardian vetoed proposal #7. ...","reason_hash":"<sha256 hex of explanation>","veto_tx":"<signature>"}
```

- `GET /decisions` returns that log as a JSON array, newest first, with CORS allowed.
- `GET /health` returns the watcher's state. `ok` is false if the last successful poll was more than three intervals ago.

## Layout

- `src/decode.ts` decodes everything read from chain: Vetowall accounts (driven by `idl/vetowall.json`), SPL Token / Token-2022 instructions, and mock_vault instructions (driven by `idl/mock_vault.json`).
- `src/rules.ts` holds the rules.
- `src/explain.ts` writes the template or Claude explanation.
- `src/main.ts` does the I/O: subscribe and poll, build each rule's context from chain, veto, log, and serve HTTP.

## Known limits

- **Mint history:** only mints executed through the timelock have a `Proposal`. Fast-lane (`execute_now`) mints don't count toward the 7-day average. Executed mints are dated by their `eta`.
- **Role changes:** these are taken from executed `set_proposer` / `set_approver` / `set_guardian` proposals, plus `Config` changes seen while the guardian runs. A direct admin change made before `seal` while the guardian was down is missed.
- **One evaluation per proposal:** each proposal is evaluated once per process. A role change after a proposal is queued doesn't re-trigger the rules on it.
