# Vetowall v2 spec: issuer control plane

This is the contract shared by the program, the issuer console (`app/`) and the guardian (`guardian/`). If an implementation has to differ from it, update this file in the same commit.

## Model

An issuer hands every Token-2022 authority it holds to Vetowall's **authority PDA** (`["authority", config]`): mint, freeze, permanent delegate, pause, metadata and close. From then on, privileged actions go through one of four paths:

| Path | Who | When it runs |
|---|---|---|
| `execute_now` | proposer + approver (both sign) | Immediately, if the instruction's class is `Safe`, or its policy has a limit and the amount fits the current window's cap. Reserve bound always applies |
| `queue` → `execute` | proposer + approver queue; anyone executes after `eta` | Everything else, after the class delay. Reserve bound is re-checked at execute |
| `guardian_execute` | guardian | Instructions registered `Safe` only (e.g. pause). No limits path |
| `veto` | guardian | Any queued proposal not targeting Vetowall itself |

All four paths refuse transactions whose first instruction is `AdvanceNonceAccount`. This is defense in depth, using the same pattern as Squads Nonce Guard and febo's p-never-nonce.

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

Proposal ["proposal", config, id_le_u64]     (unchanged from v1, plus `amount: Option<u64>` recorded for limited policies)
```

## Instructions

| Instruction | Signer | Notes |
|---|---|---|
| `initialize(proposer, approver: Option<Pubkey>, guardian, delays)` | admin | As in v1, plus `approver` |
| `register(target_program, discriminator, disc_len, class, limit: Option<Limit>)` | governor (admin before seal, authority PDA after) | Creates `Target` on first use; `disc_len` must match the existing `Target`. Registering a 2-byte discriminator on a `disc_len = 1` target adds its first byte to `wide_tags`. Refuses `target_program == vetowall` |
| `init_reserve(mint, attestor, max_age)` | governor | Creates `Reserve` |
| `attest_reserve(amount)` | attestor | Sets `amount` and `updated_at = now` |
| `seal()` | admin | As in v1 |
| `set_proposer` / `set_approver` / `set_guardian` / `set_delays` / `set_attestor` | governor | Always class `Max` once sealed |
| `queue(target_program, accounts, data)` | proposer (+ approver if set) | As in v1 |
| `execute()` | anyone | Re-checks the reserve bound if the policy has one |
| `execute_now(target_program, accounts, data)` | proposer (+ approver if set) | Fast lane. Errors: `NotFastLane`, `OverCap`, `OverReserves`, `StaleReserve` |
| `veto(reason: [u8; 32])` | guardian | `reason` = SHA-256 of the guardian's written explanation |
| `guardian_execute(target_program, accounts, data)` | guardian | `Safe` class only |

**Policy lookup:**
- Callers pass the `Target` and `Policy` accounts.
- If the `Target` doesn't exist, the class is `Max`.
- If the `Policy` doesn't exist at the address derived from `Target.disc_len`, the class is `Max`.
- Any other policy address fails with `BadPolicyAccount`.

**Amount parsing:** a little-endian u64 at `amount_offset`. Data that's too short fails with `BadAmount`.

**Mint supply:** read from the base mint layout (bytes 36..44, little-endian u64). The same layout holds for SPL Token and Token-2022.

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

Verify the Pausable extension tag and sub-tags against the `spl-token-2022-interface` crate in `~/.cargo/registry` before hard-coding them.
| Anything else | `Max` | default |

## Devnet demo config

- Delays: `Safe=0`, `Params=120s`, `Authority=180s`, `Max=300s`.
- Tests use the real delays: 0 / 48h / 72h / 7d.

## Guardian contract

- Watches `Proposal` accounts.
- **Deterministic rules decide**; the LLM only writes the explanation.
- On a hit it sends `veto(sha256(explanation))` and appends a JSONL record: `{ts, proposal, id, rule, explanation, reason_hash, veto_tx}`.
- Serves `GET /decisions` (JSON array) for the console.
