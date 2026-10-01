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
anchor build
cargo test
```

## License

MIT
