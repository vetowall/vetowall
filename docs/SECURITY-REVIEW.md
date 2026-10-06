# Vetowall security self-review

## Scope and method

Reviewed: `docs/SPEC.md`, every file under `programs/vetowall/src/` and `programs/vetowall/tests/`, including the distinct-roles and independent-attestor checks, and `programs/mock_vault/` at a skim. The client policy pack (`app/src/vetowall.ts`, `web/src/lib/vetowall.ts`) and the guardian's rule entry point (`guardian/src/rules.ts`) were read only where a finding depends on them.

Method: manual reading of each instruction's full path, from account constraints to the CPI, against the guarantees in the spec. Every finding below was traced in the code. None was reproduced as a failing test, because the build tree was in use during the review; each finding says what a reproducing test would be.

No finding lets a single role (proposer alone with an approver set, approver alone, guardian alone, attestor alone) mint, change an authority or shorten a delay. The findings are a cap that is twice what the console states, two design gaps in the timelock, and several missing input checks.

## Status

The findings below are kept as written. This is what we did about each one.

| Finding | Status |
|---|---|
| M1 | Fixed in the policy pack: `MintToChecked` is registered with a zero cap, so only `MintTo` has a fast lane. Configs created before this (including the live devnet demo) still have both caps until they re-register. A shared per-mint counter in the program is not done |
| M2 | Fixed. A proposal expires `GRACE` (14 days) after its `eta`. Test: `a_matured_proposal_expires_after_the_grace_period` |
| M3 | Narrowed. The guardian can now veto every change to Vetowall's config except its own rotation. Test: `guardian_can_veto_config_changes_other_than_its_own_rotation`. What remains by design: `set_guardian` can't be vetoed, so a compromised proposer and approver can replace the guardian after the `Max` delay. Vetowall gives a public `Max`-delay warning against that, not prevention |
| L1 | Fixed. `register` refuses a non-positive window. Test: `a_limit_window_must_be_positive` |
| L2 | Fixed. `set_attestor` resets `updated_at`. Test: `rotating_the_attestor_voids_the_last_attestation` |
| L3 | Fixed. `init_reserve` refuses a non-positive `max_age` (same test) |
| L4 | Mitigated, not removed. The program still resolves a bare one-byte policy this way (see the `ponytail:` note in `firewall.rs`). The guardian's `policy_weakening` rule now vetoes a queued `Safe` registration for any Pausable tag other than Pause, including the bare tag. The shipped policy pack is not affected |
| L5 | Fixed. `check_reserve` requires `reserve.config` to be this config |
| L6 | Fixed except for one field. `Registered` carries the limit's reserve in `subject`, and `initialize` emits an `Initialized` record. `AttestorSet` still doesn't name the reserve; the event has no spare field for it |
| L7 | Fixed. Before seal, `initialize`, `seal` and every setter take the Instructions sysvar as their first remaining account and refuse a durable-nonce transaction. Test: `presigned_setup_is_refused` |

The test gaps listed further down are still open, apart from the tests named above.

## Findings

### M1. The fast-lane cap is counted per instruction tag, so the real daily cap is twice the configured one

- `programs/vetowall/src/state.rs:148-150` (`used` and `window_start` live on each `Policy`), `programs/vetowall/src/firewall.rs:126-137` (`charge_cap`), `app/src/vetowall.ts:93-94,118` and `web/src/lib/vetowall.ts:99-100,124` (the pack registers `MintTo` and `MintToChecked` each with the full `dailyCap`).
- Input: with a daily cap of C, proposer and approver call `execute_now` with `MintTo` for C, then `MintToChecked` for C, in the same window. Both pass, because each tag has its own `Policy` account and its own counter. 2C is minted with no timelock. The reserve bound still holds, since it reads live supply.
- Smallest fix: in the policy pack, give one of the two tags `cap: 0` (keeping its reserve), so only one tag has a fast lane and the other always queues. No program change. A shared per-mint counter is the full fix and is not needed for the demo.
- Missing test: fast-lane `MintTo` for `CAP`, then `MintToChecked` for 1, expecting `OverCap`.

### M2. A matured proposal never expires and nobody but the guardian can cancel it

- `programs/vetowall/src/instructions/execute.rs:32-37`. The only conditions are `status == Queued` and `now >= eta`. There is no upper time bound and no cancel instruction.
- Input: proposer and approver queue a `SetAuthority`, a `Resume` or a large mint, then decide not to go ahead. The proposal stays executable by any account, indefinitely. It can be run months later, at a moment that suits someone else. The issuer's only remedy is to ask the guardian to veto it, and the guardian is built to act on fixed rules, not requests. For mints, the reserve re-check at execute limits the damage. For authority changes nothing does.
- Smallest fix: one constant and one line in `handle_execute`: `require!(now <= proposal.eta.saturating_add(GRACE), ErrorCode::Expired)`, with `GRACE` around 14 days. No account layout change.
- Missing test: warp past `eta + GRACE`, expect `Expired`.

### M3. No one can stop a governance proposal, and the exemption covers every Vetowall instruction, not only guardian rotation

- `programs/vetowall/src/instructions/guardian.rs:35-39`. `veto` refuses any proposal whose target is Vetowall. `guardian/src/rules.ts:173` skips those proposals too.
- The exemption exists so a compromised guardian cannot block its own rotation. As written it also covers `register`, `set_delays`, `set_proposer`, `set_approver`, `init_reserve` and `set_attestor`.
- Attack: with the proposer and approver keys (or the proposer alone when no approver is set), queue `register(Token-2022, [7], Safe, None)`, `register(Token-2022, [44, 2], Safe, None)` and `set_guardian(attacker)`. All three are class `Max` and cannot be vetoed. After the `Max` delay anyone executes them. Minting is then uncapped and has no reserve bound, the guardian's pause can be undone at once, and the guardian is the attacker's key. The admin has no power after `seal`, so no party can intervene onchain during the delay.
- What this means for the stated guarantees: against a compromise of both signers, Vetowall gives a public warning of one `Max` delay. It does not prevent the takeover. The spec should say so.
- Smallest fix: narrow the exemption to `set_guardian` by comparing `proposal.data[..8]` with that instruction's discriminator, and have the guardian raise an alert on every Vetowall-targeted proposal. The guardian can then veto a malicious `register` or `set_delays`. This does not close the hole, because `set_guardian` stays unstoppable. It forces the attacker to replace the guardian first and then wait a second delay.
- Related: the independent-attestor check (`state.rs:100-104`) runs only when an attestor is set. A later `set_proposer(attestor_key)` is not checked, as the comment at `state.rs:95-99` says. That change is a governance proposal, so the guardian cannot stop it either.

### L1. A limit with `window <= 0` makes the cap apply per call

- `programs/vetowall/src/firewall.rs:127`. `register` stores `limit` without checking it (`programs/vetowall/src/instructions/governance.rs:112-157`).
- Input: a policy registered with `window: 0` or a negative window. `now >= window_start + window` is true on every call, so `used` resets each time. Any number of mints of up to `cap` each pass the fast lane.
- Only governance can set this, so it is a configuration trap, not a privilege escalation.
- Fix: in `handle_register`, refuse a limit whose `window` is not positive.

### L2. Rotating the attestor keeps the old attestor's last figure in force

- `programs/vetowall/src/instructions/reserve.rs:63-73`. `set_attestor` changes the key and leaves `amount` and `updated_at` unchanged.
- Input: an attestor key is compromised and attests `u64::MAX`. Governance rotates it. The inflated figure remains valid until `max_age` runs out or the new attestor attests.
- Fix: one line in `handle_set_attestor`: `ctx.accounts.reserve.updated_at = 0;`. The reserve is then stale until the new attestor's first attestation.

### L3. `max_age` is unchecked and can never be changed

- `programs/vetowall/src/instructions/reserve.rs:34-47`. Any `i64` is accepted. There is no setter, and the `Reserve` PDA cannot be created twice or closed.
- Input: `max_age = i64::MAX` turns staleness off for good. A negative value makes the reserve permanently stale, and every mint under a policy that names it fails. This config cannot create a second reserve for the same mint.
- Fix: `require!(max_age > 0)` in `handle_init_reserve`. Let `set_attestor` take `max_age` if it must be adjustable.

### L4. A one-byte policy on an extension tag covers every sub-instruction

- `programs/vetowall/src/instructions/governance.rs:136`, `programs/vetowall/src/firewall.rs:42-51`.
- A tag becomes "wide" only when a policy with a non-zero second byte is registered. Until then, a policy registered as `[44]` (or `[44, 0]`, which is the same address) matches `Pause`, `Resume` and every other Pausable sub-instruction.
- Input: an issuer registers `[44]` as `Safe`, meaning "pause". The guardian can then run `Resume`, which the spec says it must never do. The shipped pack registers `[44, 1]` and `[44, 2]` and is not affected.
- Fix: document it in the spec and have the console refuse to register a one-byte `Safe` policy for a Token-2022 extension tag. A program-side fix would need `register` to take an explicit "wide" flag, so that sub-tag 0 can be told apart from the bare tag.
- Missing test: register `[44]` as `Safe` on a fresh config, show the guardian can resume. That pins the behaviour either way.

### L5. `check_reserve` does not check that the `Reserve` belongs to this config

- `programs/vetowall/src/firewall.rs:152-153`. The reserve's key must equal `limit.reserve` and its `mint` must match. Its `config` field is not compared.
- Input: a governance proposal registers a limit whose `reserve` is a `Reserve` created under another config, with an attestor that config chose. The mint key matches, so the check passes against a figure this config's attestor never signed. It needs a `Max` proposal, and the `Registered` record does not show the reserve (see L6).
- Fix: pass the config key into `check_reserve` and add `require_keys_eq!(reserve.config, *config, ErrorCode::BadReserveAccount)`.

### L6. Gaps in the change record

- `programs/vetowall/src/instructions/initialize.rs:17-38`: `initialize` emits nothing. The first roles and delays of a config are missing from the timeline, although the spec says every privileged instruction emits a record.
- `programs/vetowall/src/instructions/governance.rs:158-164`: `Registered` carries the cap but not `window`, `reserve`, `mint_index` or `amount_offset`. Re-registering a mint policy with `reserve: None` or `window: 0` produces the same record as the original registration.
- `programs/vetowall/src/instructions/reserve.rs:68-71`: `AttestorSet` names the new attestor but not the reserve or mint.
- Fix: emit a record from `initialize`. Put `limit.reserve` in `subject` for `Registered`. The remaining fields can be read from the instruction data, as the spec already says for delays.

### L7. Admin instructions accept durable-nonce transactions before `seal`

- `governance.rs` (`register`, `set_*`, `seal`), `reserve.rs` (`init_reserve`, `set_attestor`) and `initialize.rs` do not call `forbid_durable_nonce`. After `seal` they are reachable only through `execute`, which does.
- Input: a pre-signed admin `register(MintTo, Safe, None)` or `set_guardian` lands just before `seal`, after the setup was reviewed.
- This is limited to the setup phase, when the admin is fully trusted. The mitigation is to read the config, targets and policies back from the chain after `seal` and compare them with the intended pack. No code change is proposed.

## Test gaps

Guarantees stated in the spec with no test:

- Durable-nonce refusal on `execute_now`, `guardian_execute` and `attest_reserve`. Only `queue` and `execute` are tested.
- Governance after `seal` other than `set_guardian`: `register` with the authority PDA paying rent, `set_delays`, `set_proposer`, `set_approver`, `init_reserve`, `set_attestor`. Direct calls by the old admin are tested only for `set_guardian`.
- `seal` twice (`AlreadySealed`), and `queue` or `execute_now` before `seal` (`NotSealed`).
- `BadDelays`, `TooManyAccounts`, `DataTooLarge`, `BadAmount` on short data, `BadDiscriminator`, `WideTagsFull`, `SelfPolicy`.
- Reserve substitution: a different `Reserve` account, or a different mint at `mint_index`. Only the omitted reserve is tested.
- `MintToChecked` (see M1) and the `Burn` policies.
- Vetoing a proposal that was already executed or vetoed.
- Records for `Registered`, `Sealed`, `ProposerSet`, `ApproverSet`, `GuardianSet`, `DelaysSet`, `ReserveInitialized`, `ReserveAttested` and `AttestorSet`.

## Checked and found sound

- **Maker-checker.** With an approver set, `queue` and `execute_now` need both signatures, and a different signer in the approver slot is refused (`state.rs:108-116`). Test: `missing_approver_signature_fails`.
- **One key cannot hold two roles.** Checked after every write to a role, and for the attestor when it is set. Tests: `a_config_cannot_be_created_with_one_key_in_two_roles`, `a_role_cannot_be_changed_to_a_key_that_holds_another`, `the_attestor_cannot_be_a_signer_of_mints`.
- **The guardian can stop but not act.** `guardian_execute` requires a policy that is `Safe` and has no limit. Instructions that are unregistered or target Vetowall resolve to no policy and are refused. Tests: `guardian_can_pause_but_nothing_else`, `pausable_sub_instructions_resolve_to_their_own_policies`.
- **Pause and Resume do not collide** once registered as two-byte policies. Test: `pausable_sub_instructions_resolve_to_their_own_policies`.
- **The policy cannot be swapped.** The target and policy addresses are re-derived from the config, the program and the instruction data. A missing account can only make the class stricter. Test: `only_the_proposer_queues_and_only_the_authority_signs`.
- **The queued instruction is bound.** The program id, account metas and data are stored in the proposal, and `execute` uses only those. The caller supplies account infos, which the runtime matches by key. Read in code; `each_class_waits_out_its_own_timelock` and `over_cap_mint_waits_out_the_timelock` exercise the path.
- **No replay.** `execute` and `veto` both require `Queued`. Tests: `each_class_waits_out_its_own_timelock`, `guardian_veto_stops_the_drift_replay`. A proposal that calls `execute` on itself or on a cycle of proposals recurses until the CPI depth limit and fails; no finite path runs a proposal twice (read in code, no test).
- **Only the authority PDA signs.** Stored metas may mark no other signer, and the PDA seeds include the config key, so a config an attacker creates controls a different PDA. Test: `only_the_proposer_queues_and_only_the_authority_signs`.
- **Timelocks per class, unregistered means `Max`.** Test: `each_class_waits_out_its_own_timelock`.
- **After `seal` the admin and the guardian cannot change the config directly**, and the guardian cannot block its rotation. Test: `config_changes_take_the_max_timelock_and_the_guardian_cannot_block_its_rotation`. Every governance handler calls `require_governor` (read in code).
- **Cap and window arithmetic.** `checked_add` on `used`, `saturating_add` on the window end, and overflow checks are on in release. Tests: `mint_within_cap_runs_instantly`, `over_cap_mint_waits_out_the_timelock`, `cap_window_resets_after_a_day`.
- **Reserve bound.** The reserve key, the mint key at `mint_index`, the mint's owner program, staleness, then `supply + amount` with a checked add, on the fast lane and again at `execute`. A new reserve is stale until first attested. Tests: `mint_above_attested_reserves_fails_on_both_paths`, `stale_attestation_is_refused`, `mint_within_cap_runs_instantly` (omitted reserve), `only_the_attestor_can_attest`.
- **Durable-nonce refusal.** The sysvar address is checked twice, by the account constraint and inside `load_instruction_at_checked`. The runtime requires the nonce advance at instruction index 0, which is the index checked. Tests: `presigned_durable_nonce_queue_is_refused`, `presigned_durable_nonce_execute_is_refused`.
- **Proposal accounts cannot be squatted.** Anchor's `init` handles an address that was pre-funded, and the seed is a counter only `queue` advances. Read in code.

## Known limits, by design

- **Before `seal` the admin is fully trusted.** It can register any policy and set any role. A sealed config is only as good as the policies registered before sealing. Read them back from the chain.
- **Delays have no floor.** `validate_delays` accepts all zeros, so "sealed" does not by itself mean "timelocked".
- **Policies bind an instruction tag, not its accounts or arguments.** A `Params` policy for `FreezeAccount` covers every token account, and a `Safe` policy for `Pause` covers every mint the PDA controls.
- **The reserve bound covers only instructions registered with a limit.** A `Max` proposal can mint through an unregistered instruction or move the mint authority away, after the `Max` delay.
- **One reserve per policy.** A config whose PDA holds authority over two mints of the same token program can fast-lane only one of them.
- **The window is fixed, not sliding.** A full cap just before a reset and another just after is allowed.
- **The attestor is a single key.** It can remove the reserve bound by attesting a large figure, or block minting by attesting zero. It cannot mint. The cap and the timelock still apply.
- **The guardian can veto every non-governance proposal.** That halts queued operations until it is rotated, which takes one `Max` delay.
- **Losing the proposer key, or the approver key when one is set, bricks the config for good.** Nothing can be queued, including the rotation of the lost key, and the authorities stay in the PDA. Both roles should be multisigs.
- **The nonce check stops durable-nonce transactions only.** A multisig proposal approved long ago and executed today still passes it; the timelock is the control for that case.
- **Proposal accounts are never closed.** Their rent is not recoverable.
