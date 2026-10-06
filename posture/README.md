# posture

A small scanner that reads from Solana mainnet who holds the privileged authorities of large
stablecoin and tokenized-asset mints. It backs the numbers we quote about how issuers hold
their mint, freeze, permanent-delegate and pause authorities today. It states what the chain
shows and makes no judgement about any issuer.

## Run it

```sh
npm ci
npm run check   # offline self-check of the parsers and the classifier
npm run scan    # reads mainnet, rewrites results.json and SUMMARY.md
```

Node 22 or newer. `RPC_URL` selects the node and defaults to
`https://api.mainnet-beta.solana.com`, where a scan takes about eight minutes because the node
rate-limits and we back off on 429. Only the RPC host name is written to the output, never the
URL, so a URL with an API key is fine to use.

`assets.json` is the input, with the URL each mint address came from. `fixtures.json` holds one
real SPL multisig account for the self-check. `results.json` and `SUMMARY.md` are generated.

## Method

1. **Asset list.** Stablecoins with at least $10M circulating on Solana per DefiLlama, plus the
   larger tokenized funds, gold and a sample of stock tokens listed on CoinGecko. Mint addresses
   come from DefiLlama's `chainConfig` or CoinGecko's `platforms.solana`, never from memory.
   We dropped mints with under about $100k of supply on Solana.
2. **Roles.** We ask the node for each mint with `jsonParsed`, so the reference Token-2022
   parser decodes the extensions. We take the mint and freeze authority, the permanent
   delegate, and every extension field whose name ends in "authority". A mint with an extension
   the node cannot decode is skipped and listed, not partly reported.
3. **Classification** of each authority address, from its own account:
   - `none`: the authority has been removed.
   - `system-key`: on-curve, owned by the System Program or with no account yet.
   - `spl-multisig`: owned by a token program, 355 bytes, valid m-of-n. Members are classified
     one level down.
   - `squads-v4-vault`: we find the multisig in the vault's recent transactions and accept it
     only if re-deriving the vault PDA from it gives the same address. We report threshold,
     member count and `time_lock`.
   - `program-pda`: off-curve, with an account owned by some other program.
   - `pda-unresolved`: off-curve, with no account or one owned by the System or a token program.
4. **Delay.** Only a resolved Squads `time_lock` above zero counts as a provable onchain delay.

## Limits

- A system-owned key may be an MPC or HSM key with offchain approval policies and limits. The
  chain cannot show that, and cannot tell such a key from a hot key.
- We do not read program logic. For both PDA classes a cap, a delay or a role check may exist
  inside the program, and an issuer may enforce caps offchain. "None visible onchain" means only
  that the account data we read does not prove a delay.
- `pda-unresolved` covers PDAs whose deriving program we could not prove from account data, and
  Squads vaults with no Squads transaction among their last 20 or a vault index of 16 or more.
- `program-pda` names the account's owner, which is usually but not provably the program that
  signs for it. We do not look at who can upgrade that program.
- We do not read Metaplex metadata, which has its own update authority on classic SPL mints.
- The list is curated and the stock tokens are a sample of two issuers. Counts are per mint.
- Authorities change. Every number is true for the slot in `results.json` and nothing later.
