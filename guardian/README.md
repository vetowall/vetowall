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
npm install --no-audit --no-fund
cp .env.example .env        # set CONFIG and GUARDIAN_KEYPAIR
npm run dry-run             # decides and logs, sends nothing
npm start                   # vetoes for real
npm test                    # node:test unit tests
npm run typecheck
```

`--dry-run` doesn't need a keypair. Its log records have `"veto_tx": null`.

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
