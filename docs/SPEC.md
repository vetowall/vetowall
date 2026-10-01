# Vetowall v2 spec: issuer control plane

This is the contract shared by the program, the issuer console (`app/`) and the guardian (`guardian/`). If an implementation has to differ from it, update this file in the same commit.

## Model

An issuer hands every Token-2022 authority it holds to Vetowall's **authority PDA** (`["authority", config]`): mint, freeze, permanent delegate, pause, metadata and close. From then on, privileged actions go through one of four paths:

| Path | Who | When it runs |
|---|---|---|
| `execute_now` | proposer + approver (both sign) | Immediately, if the instruction's class is `Safe`, or its policy has a limit and the amount fits the current window's cap. Reserve bound always applies |
| `queue` → `execute` | proposer + approver queue; anyone executes after `eta` | Everything else, after the class delay. Reserve bound is re-checked at execute |
| `guardian_execute` | guardian | Instructions registered `Safe` only (e.g. pause). No limits path: a policy with a `limit` is refused (`NotSafeClass`) |
| `veto` | guardian | Any queued proposal not targeting Vetowall itself |

All four paths, and `attest_reserve`, refuse transactions whose first instruction is `AdvanceNonceAccount`. This is defense in depth, using the same pattern as Squads Nonce Guard and febo's p-never-nonce.

## Accounts

```
Config (keypair account)
  admin, proposer, approver: Option<Pubkey>, guardian,
  delays: [i64; 4]  (Safe, Params, Authority, Max)
  sealed, proposal_count, authority_bump

Target  ["target", config, program]          (one per target program)
  config, program, disc_len: u8               (1 for SPL Token / Token-2022, 8 for Anchor)
  wide_tags: Vec<u8> (max 16)                 (first bytes whose discriminator is 2 bytes: Token-2022
                                               extension instructions, e.g. Pausable = [tag, 1|2])

Policy  ["policy", config, program, disc]    (disc = data[..n] zero-padded to 8 bytes, where
                                              n = 2 if disc_len == 1 and data[0] in wide_tags, else disc_len)
  config, target_program, discriminator: [u8; 8], class: ActionClass,
  limit: Option<Limit>, used: u64, window_start: i64

Limit
  amount_offset: u8          (byte offset of the little-endian u64 amount in ix data; MintTo/MintToChecked = 1)
  cap: u64                   (per window, fast lane only)
  window: i64                (seconds, e.g. 86400)
  reserve: Option<Pubkey>    (Reserve account; if set, supply + amount <= reserve.amount, on every path)
  mint_index: u8             (index in the stored ix accounts of the mint whose supply is checked)

Reserve ["reserve", config, mint]
  config, mint, attestor, amount: u64, updated_at: i64, max_age: i64

Proposal ["proposal", config, id_le_u64]     (v1 fields, then, appended in this order:)
  amount: Option<u64>        (recorded for limited policies)
  executed_at: i64           (set by `execute`; 0 until then)
  discriminator: [u8; 8]     (policy key the instruction was classified by; see Events)
```

Proposal fields are only ever appended. Proposals are allocated at max size and serialized compactly, so one created before a field existed reads it as zero.

## Instructions

| Instruction | Signer | Notes |
|---|---|---|
| `initialize(proposer, approver: Option<Pubkey>, guardian, delays)` | admin | As in v1, plus `approver` |
| `register(target_program, discriminator, disc_len, class, limit: Option<Limit>)` | governor (admin before seal, authority PDA after) | Creates `Target` on first use; `disc_len` (1..=8) must match the existing `Target`. On a `disc_len = 1` target, a non-zero `discriminator[1]` makes it a 2-byte discriminator and adds `discriminator[0]` to `wide_tags`. Bytes past the discriminator's length must be zero (`BadDiscriminator`). Refuses `target_program == vetowall`. Re-registering keeps `used` / `window_start` |
| `init_reserve(mint, attestor, max_age)` | governor | Creates `Reserve` |
| `attest_reserve(amount)` | attestor | Sets `amount` and `updated_at = now`. Takes the Instructions sysvar and refuses durable-nonce txs: a pre-signed attestation would look fresh whenever it landed |
| `seal()` | admin | As in v1 |
| `set_proposer` / `set_approver` / `set_guardian` / `set_delays` / `set_attestor` | governor | Always class `Max` once sealed |
| `queue(target_program, accounts, data)` | proposer (+ approver if set) | As in v1 |
| `execute()` | anyone | Checks the reserve bound (against supply at execute time) if the policy has one. `queue` doesn't check it |
| `execute_now(target_program, accounts, data)` | proposer (+ approver if set) | Fast lane. Errors: `NotFastLane`, `OverCap`, `OverReserves`, `StaleReserve`, `BadAmount`. A `Safe` policy skips the cap; the reserve bound still applies if it has a limit. The reserve bound is checked before the cap, so a mint over both fails with `OverReserves` |
| `veto(reason: [u8; 32])` | guardian | `reason` = SHA-256 of the guardian's written explanation |
| `guardian_execute(target_program, accounts, data)` | guardian | `Safe` class only |

**Policy lookup:**
- Callers pass the `Target` and `Policy` accounts.
- If the `Target` doesn't exist, the class is `Max`.
- If the `Policy` doesn't exist at the address derived from `Target.disc_len`, the class is `Max`.
- Any other policy address fails with `BadPolicyAccount`.

**Accounts** (full order in `idl/vetowall.json`): `queue` and `execute_now` take `proposer`, optional `approver` (pass the Vetowall program ID for none), `target`, `policy`. `execute` and `execute_now` also take an optional `reserve`, required when the policy's limit names one. `guardian_execute` takes `target`, `policy`. The stored instruction's accounts, in order, then its program, go in remaining accounts; `mint_index` indexes into them.

**Cap window:** fixed, not sliding. It restarts at the first `execute_now` at or after `window_start + window`.

**Reserve bound:** `Reserve` key must equal `limit.reserve`; the account at `mint_index` must match the stored meta and `reserve.mint`, and be owned by SPL Token or Token-2022 (`BadReserveAccount` otherwise). Staleness (`now - updated_at > max_age`) is checked before the amount. A new `Reserve` has `updated_at = 0`, so it is stale until first attested. One reserve per policy, so a policy's limit covers one mint.

**Errors added beyond the ones named above:** `NotApprover`, `BadDiscriminator`, `WideTagsFull`, `BadReserveAccount`, `NotAttestor` (appended after v1's codes; see the IDL for numbers).

**Amount parsing:** a little-endian u64 at `amount_offset`. Data that's too short fails with `BadAmount`.

**Mint supply:** read from the base mint layout (bytes 36..44, little-endian u64). The same layout holds for SPL Token and Token-2022.

## Events

Every privileged instruction emits one Anchor event, `ChangeRecord` (`emit!`, so a `Program data:` log line; discriminator in the IDL). It is the onchain change-control record: the console builds its timeline and report from these, read from the transaction history of the config (and of each `Reserve`, since `attest_reserve` doesn't take the config).

```
ChangeRecord
  kind: RecordKind
  config: Pubkey
  proposal_id: Option<u64>
  target_program: Pubkey         (default key when no instruction is routed)
  discriminator: [u8; 8]         (policy key of the routed instruction: data[..n] zero-padded, n from
                                  Target.disc_len and wide_tags; data[..8] when there is no Target)
  amount: Option<u64>
  class: Option<ActionClass>
  actor: Pubkey                  (the signer that acted)
  approver: Option<Pubkey>
  subject: Option<Pubkey>
  reason: [u8; 32]               (veto reason hash, zero otherwise)
  timestamp: i64                 (Clock unix_timestamp)
```

| `kind` | Emitted by | proposal_id | target_program / discriminator | amount | class | actor | approver | subject |
|---|---|---|---|---|---|---|---|---|
| `Queued` | `queue` | yes | routed ix | limited policy's amount | resolved class | proposer | approver | |
| `Executed` | `execute` | yes | routed ix | from proposal | from proposal | default key (anyone may execute) | | |
| `ExecutedNow` | `execute_now` | | routed ix | limited policy's amount | policy class | proposer | approver | |
| `Vetoed` | `veto` | yes | from proposal | from proposal | from proposal | guardian | | |
| `GuardianExecuted` | `guardian_execute` | | routed ix | | `Safe` | guardian | | |
| `ReserveInitialized` | `init_reserve` | | | | | governor | | mint |
| `ReserveAttested` | `attest_reserve` | | | attested amount | | attestor | | mint |
| `AttestorSet` | `set_attestor` | | | | | governor | | new attestor |
| `Registered` | `register` | | registered program / discriminator | `limit.cap` | registered class | governor | | |
| `Sealed` | `seal` | | | | | admin | | |
| `ProposerSet` / `ApproverSet` / `GuardianSet` | `set_*` | | | | | governor | | new key (`None` = approver removed) |
| `DelaysSet` | `set_delays` | | | | | governor | | |

After `seal`, governance changes run as a proposal's CPI into Vetowall, so that transaction carries two records: `Executed` for the proposal and the `*Set` / `Registered` record from the inner call. New delays aren't in the record; read them from the config or the instruction data. Failed transactions emit nothing; a refused attempt is evidenced by the failed transaction itself (its instruction data and error log).

## Issuer policy pack (Token-2022 / SPL Token, `disc_len = 1`)

| Instruction (tag) | Class | Limit |
|---|---|---|
| `MintTo` (7), `MintToChecked` (14) | `Params` | cap per day + reserve, `amount_offset = 1`, `mint_index = 0` |
| `FreezeAccount` (10) | `Params` | none |
| `ThawAccount` (11) | `Params` | none |
| `Burn` via permanent delegate (8, 15) | `Authority` | none |
| `SetAuthority` (6) | `Max` | none |
| Pausable `Pause` (2-byte: extension tag + 1) | `Safe` | guardian may run it |
| Pausable `Resume` (2-byte: extension tag + 2) | `Params` | none |

| Anything else | `Max` | default |

Pausable, checked against `spl-token-2022-interface` 2.1.0: `TokenInstruction::PausableExtension = 44`, sub-tags `Initialize = 0`, `Pause = 1`, `Resume = 2`. So `Pause` = `[44, 1]`, `Resume` = `[44, 2]`.

## Devnet demo config

- Delays: `Safe=0`, `Params=120s`, `Authority=180s`, `Max=300s`.
- Tests use the real delays: 0 / 48h / 72h / 7d.

## Guardian contract

- Watches `Proposal` accounts.
- **Deterministic rules decide**; the LLM only writes the explanation.
- On a hit it sends `veto(sha256(explanation))` and appends a JSONL record: `{ts, proposal, id, rule, explanation, reason_hash, veto_tx}`.
- Serves `GET /decisions` (JSON array) for the console.
