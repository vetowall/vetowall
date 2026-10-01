# Vetowall

The control plane for stablecoin and tokenized-asset issuers on Solana: no single key, human or AI, can mint, freeze or seize outside policy.

Every stablecoin and tokenized asset is controlled by admin keys that can mint, freeze or seize at will, usually with no onchain delay or cap. That is what failed at Drift (~$285M, April 2026: pre-signed admin transactions against a multisig whose timelock had been removed), Resolv ($80M of unbacked USR minted with a compromised key, March 2026) and Paxos ($300T of PYUSD minted by mistake, October 2025).

Vetowall is a Solana program that holds an issuer's Token-2022 authorities through its authority PDA. From then on:

- **Every privileged instruction has a class and a timelock.** Each admin instruction is registered as `Safe`, `Params`, `Authority` or `Max`, and each class has its own delay. Unregistered instructions default to `Max`. Once the config is sealed, changing Vetowall's own settings is itself a `Max` action, so nobody can quietly remove the delays.
- **Mints are bounded** (in progress, see [docs/SPEC.md](docs/SPEC.md)). A maker-checker fast lane runs routine mints immediately up to a daily cap. Anything above the cap waits out the timelock, and no path can mint above attested reserves.
- **The guardian can only stop things.** A guardian key can veto queued proposals and run instructions registered as `Safe` (such as pause). It can't mint, unpause or move funds, and it can't veto changes to Vetowall's own config, so it can't block its own rotation.
- **Durable-nonce transactions are refused** on every path, as defense in depth. This uses the same Instructions-sysvar check as [Squads Nonce Guard](https://github.com/Squads-Protocol/nonce-guard) and [p-never-nonce](https://github.com/febo/pinocchio-never-nonce). On its own it would not have stopped Drift, because the attacker could execute pre-approved proposals with a fresh blockhash. The timelock and the veto are what stop that pattern.

Vetowall doesn't issue tokens or hold reserves. It sits between whatever signs (a Squads multisig, a single key, an issuance provider's API) and the asset, and works alongside them.

> Status: in active development for the Colosseum Crypto World's Fair (Sep 14 to Oct 12, 2026). The programs are live on devnet. The issuer console and demo config are next.

## Devnet

| Program | Address |
|---|---|
| `vetowall` | [`G8LSBa3y5XqY5fK4R6NTK84oPru3W3hsNzRwjunLWedr`](https://explorer.solana.com/address/G8LSBa3y5XqY5fK4R6NTK84oPru3W3hsNzRwjunLWedr?cluster=devnet) |
| `mock_vault` | [`46BaaWFuFK3T8akXjL2xFzcv6M5AWAKXFcuxdU3jfc3a`](https://explorer.solana.com/address/46BaaWFuFK3T8akXjL2xFzcv6M5AWAKXFcuxdU3jfc3a?cluster=devnet) |

Built with `anchor build --arch v0` from the commit tagged `devnet-2026-10-01`. The devnet demo config uses short delays (Safe 0s, Params 120s, Authority 180s, Max 300s) so the flow fits in a demo. The tests check the real delays: 48h, 72h and 7 days.

## Prior work and credits

- **[OpenZeppelin AccessManager](https://docs.openzeppelin.com/contracts/5.x/access-control)** (EVM): a role and execution delay per function selector with a cancelling guardian. Vetowall applies the same idea to Solana programs and Token-2022 authorities.
- **[Squads Smart Account](https://github.com/Squads-Protocol/smart-account-program) policies**: per-policy timelocks on the wallet side. Vetowall enforces on the asset side instead, so its limits hold even if the signing wallet is compromised, migrated or misconfigured.
- **[Chainlink Proof of Reserve Secure Mint](https://blog.chain.link/secure-mint/)**: reserve-gated minting, already live on Solana. Vetowall's reserve bound takes an attested reserve account, and a Chainlink PoR adapter is planned.
- **Earlier Colosseum hackathon projects in this space:** [Guardrail](https://colosseum.com/projects/explore/guardrail) (authority-wrapping primitive), [Settlin](https://colosseum.com/projects/explore/settlin) (PDA co-signer with transfer limits) and [Killswitch](https://colosseum.com/projects/explore/killswitch) (monitoring with auto-pause). Vetowall differs by holding issuers' Token-2022 authorities directly, bounding mints by attested reserves, and producing change-control records.

## Layout

| Path | What it is |
|---|---|
| `programs/vetowall` | The control program (Anchor) |
| `docs/SPEC.md` | The v2 spec shared by the program, the issuer console and the guardian |
| `programs/mock_vault` | A small lending vault used to replay the Drift attack, with and without Vetowall |
| `idl/` | Generated IDLs for both programs |
| `docs/SPEC.md` | The v2 contract shared by the program, console and guardian |

## Build and test

Requires Agave CLI 4.3 and Anchor CLI 1.2.

```sh
anchor build --arch v0   # SBPF v0 loads on every cluster and in LiteSVM
cargo test -p vetowall   # drift_replay + issuer
```

The generated IDLs are committed in `idl/` for the console and the guardian. `docs/SPEC.md` is the v2 contract (issuer control plane).

`programs/vetowall/tests/drift_replay.rs` runs the attack in LiteSVM with the real timelocks (48h, 72h, 7 days), skipping the clock forward:

| Test | What it shows |
|---|---|
| `control_unguarded_vault_is_drained_by_presigned_admin_tx` | A hot admin key pre-signs "list collateral + raise withdraw limit 20x" against a durable nonce. 300 blocks later it lands, and a worthless token borrows the whole reserve |
| `presigned_durable_nonce_queue_is_refused` | The same pre-signed pattern against Vetowall fails with `NonceTxForbidden` |
| `presigned_durable_nonce_execute_is_refused` | Executing a matured proposal from a durable-nonce transaction also fails |
| `each_class_waits_out_its_own_timelock` | A listing waits 48h; an unregistered instruction defaults to 7 days |
| `guardian_veto_stops_the_drift_replay` | The guardian vetoes both proposals, they can never execute, and the reserve is untouched |
| `guardian_can_pause_but_nothing_else` | The guardian can pause instantly, but can't unpause or change limits |
| `config_changes_take_the_max_timelock_and_the_guardian_cannot_block_its_rotation` | Rotating the guardian takes 7 days and the guardian can't veto it |
| `only_the_proposer_queues_and_only_the_authority_signs` | Forged proposers, foreign signers and swapped policy accounts are rejected |

`programs/vetowall/tests/issuer.rs` runs a stablecoin issuer on a real Token-2022 mint (with the Pausable extension) whose mint, freeze and pause authorities are Vetowall's PDA:

| Test | What it shows |
|---|---|
| `mint_within_cap_runs_instantly` | A mint inside the daily cap runs through `execute_now` with proposer + approver, and is charged to the window. Leaving out the reserve account fails |
| `over_cap_mint_waits_out_the_timelock` | Over the cap, `execute_now` fails with `OverCap`; the same mint queued as `Params` executes after 48h |
| `mint_above_attested_reserves_fails_on_both_paths` | Supply + amount above the attested reserves fails with `OverReserves` in the fast lane and at `execute` |
| `stale_attestation_is_refused` | An attestation older than its max age fails with `StaleReserve` until re-attested |
| `cap_window_resets_after_a_day` | The cap stays spent until the 24h window ends, then refills |
| `missing_approver_signature_fails` | Without the approver (or with the wrong one), `queue` and `execute_now` fail with `NotApprover` |
| `only_the_attestor_can_attest` | The admin, proposer or an attacker can't attest reserves |
| `freeze_goes_through_the_params_timelock` | `FreezeAccount` has no fast lane; queued, it freezes the account after 48h |
| `pausable_sub_instructions_resolve_to_their_own_policies` | Pause `[44, 1]` and Resume `[44, 2]` share a first byte but hit separate policies: the guardian pauses instantly, Resume takes 48h |

## License

MIT
