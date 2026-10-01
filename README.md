# Airlock

An onchain firewall between a Solana protocol's multisig and its admin instructions.

In April 2026 Drift lost $285M. Its contracts weren't broken. Security Council signers were tricked into pre-signing durable-nonce transactions, which were executed days later against a 2-of-5 multisig with a 0-second timelock. Airlock closes that path in a program, so there is no offchain party to bypass:

- **Per-action timelocks.** Every admin instruction the protocol exposes is registered with a class (`Safe`, `Params`, `Authority`, `Max`), and each class has its own delay. Unknown instructions default to `Max`. Changing the delays is itself a `Max` action.
- **Durable-nonce refusal.** `queue` and `execute` read the Instructions sysvar and fail if the transaction starts with `AdvanceNonceAccount`, so a pre-signed, future-executable payload can't reach the protocol.
- **Veto-only guardian.** A guardian key can veto queued proposals and run instructions registered as `Safe` (such as `pause`). It can't execute anything else or move funds, and it can't veto changes to Airlock's own config, so it can't block its own rotation.

The protocol sets its admin authority to Airlock's authority PDA. From then on, every admin action goes through `queue` → wait out the class delay → `execute`.

> Status: in active development for the Colosseum Crypto World's Fair (Sep 14 to Oct 12, 2026). Devnet deployment, live demo URL and explorer links will be added here.

## Layout

| Path | What it is |
|---|---|
| `programs/airlock` | The firewall program (Anchor) |
| `programs/mock_vault` | A small lending vault used to replay the Drift attack, with and without Airlock |

## Build and test

Requires Agave CLI 4.3 and Anchor CLI 1.2.

```sh
anchor build --arch v0   # SBPF v0 loads on every cluster and in LiteSVM
cargo test -p airlock --test drift_replay
```

`programs/airlock/tests/drift_replay.rs` runs the attack in LiteSVM with the real timelocks (48h, 72h, 7 days), skipping the clock forward:

| Test | What it shows |
|---|---|
| `control_unguarded_vault_is_drained_by_presigned_admin_tx` | A hot admin key pre-signs "list collateral + raise withdraw limit 20x" against a durable nonce. 300 blocks later it lands, and a worthless token borrows the whole reserve |
| `presigned_durable_nonce_queue_is_refused` | The same pre-signed pattern against Airlock fails with `NonceTxForbidden` |
| `presigned_durable_nonce_execute_is_refused` | Executing a matured proposal from a durable-nonce transaction also fails |
| `each_class_waits_out_its_own_timelock` | A listing waits 48h; an unregistered instruction defaults to 7 days |
| `guardian_veto_stops_the_drift_replay` | The guardian vetoes both proposals, they can never execute, and the reserve is untouched |
| `guardian_can_pause_but_nothing_else` | The guardian can pause instantly, but can't unpause or change limits |
| `config_changes_take_the_max_timelock_and_the_guardian_cannot_block_its_rotation` | Rotating the guardian takes 7 days and the guardian can't veto it |
| `only_the_proposer_queues_and_only_the_authority_signs` | Forged proposers, foreign signers and swapped policy accounts are rejected |

## License

MIT
