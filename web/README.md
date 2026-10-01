# Vetowall console (Next.js)

The issuer console for Vetowall, rebuilt on Next.js 16 (App Router). It replaces the static Vite app in [`app/`](../app), which keeps serving GitHub Pages until the switchover.

| Route | What it shows |
|---|---|
| `/` | Overview: what Vetowall is and who it's for, live proof (god keys, supply against attested reserves, fast-lane usage, timelock queue), the key onchain events with Explorer links, how it works |
| `/operate` | Maker-checker mint (`execute_now` or `queue`), reserve attestation, the proposals timeline with countdowns and Execute |
| `/comply` | Change-control report (CSV, JSON, print) with each column mapped to a control in the OCC's proposed 12 CFR 15.13; freeze via policy |
| `/guardian` | Guardian powers, onchain vetoes, the decision feed with each reason hash re-checked in the browser, manual pause and veto |
| `/launch` | Create a Token-2022 mint with every authority on the Vetowall PDA, then the config, policy pack, reserve and seal |

## How data flows

- **The RPC key never reaches the browser.** `SOLANA_RPC_URL` is read only on the server.
  - The browser's `Connection` points at `/api/rpc` (`app/api/rpc/route.ts`, logic in `src/lib/rpc-proxy.ts`). It forwards single and batched JSON-RPC calls, but only for an allowlist: the reads the console makes (`getAccountInfo`, `getMultipleAccounts`, `getTransaction`, `getBalance`, `getMinimumBalanceForRentExemption`) and sending (`sendTransaction`, `simulateTransaction`, `getLatestBlockhash`, `getSignatureStatuses`, `getFeeForMessage`).
  - Bodies are capped at 16 kB and batches at 10 calls. Each IP gets 120 calls a minute.
  - The proxy can't carry WebSockets, so the console confirms transactions by polling `getSignatureStatuses`.
  - Devnet airdrops go straight to the public devnet RPC, which needs no key.
- **One cached snapshot for everyone.** `src/lib/snapshot.ts` reads the live config, mint, reserve, policy and proposals, plus the `ChangeRecord` history, on the server. The history is fetched one transaction at a time with backoff. The result is cached for about 15 seconds (`unstable_cache`), and pages render with it on the server. The browser then refreshes from `/api/snapshot` every 20 seconds instead of crawling history itself.
- **A token launched from a browser** is remembered in `localStorage`. It is read through `/api/snapshot?config=…&mint=…`, uncached, so its owner sees their own transactions at once (rate-limited per IP).
- **Sample data only as a fallback.** If the live issuer can't be read, every page shows a fictional issuer, Sample Dollar (`SAMPLE`), with a "Sample data" badge and banner. Its addresses are not links.
- **Guardian decisions.** `/api/decisions` proxies `GET $GUARDIAN_URL/decisions` when `GUARDIAN_URL` is set. Otherwise it serves sample decisions, labelled as such.

## Run

```sh
npm ci
cp .env.example .env.local   # optional; defaults work against public devnet
npm run dev                  # http://localhost:3000
npm test                     # report, records, RPC allowlist and rate limit (node:test)
npm run build
```

| Variable | Scope | Default | Purpose |
|---|---|---|---|
| `SOLANA_RPC_URL` | server only | `https://api.devnet.solana.com` | Keyed devnet RPC (e.g. Helius). Never prefix it with `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_VETOWALL_CONFIG` | public | `BQodWY1t1CVVJHpGdR9UnDg3wY3gyTsBDne5y2hSfTgp` | The Vetowall config to show (the live vUSD demo) |
| `GUARDIAN_URL` | server only | none | Guardian service base URL |

## Deploy on Vercel

1. In Vercel, **Add New → Project** and import the `vetowall/vetowall` repository.
2. Set **Root Directory** to `web`. The framework preset is detected as Next.js; keep the default build and install commands.
3. Under **Environment Variables** (Production and Preview), add:
   - `SOLANA_RPC_URL`: your Helius devnet URL, `https://devnet.helius-rpc.com/?api-key=…`
   - `NEXT_PUBLIC_VETOWALL_CONFIG`: `BQodWY1t1CVVJHpGdR9UnDg3wY3gyTsBDne5y2hSfTgp` (or a config from `npm run seed:devnet` in `app/`)
   - `GUARDIAN_URL`: optional, the guardian service's base URL
4. Deploy. Open `/api/snapshot` on the deployment and check that `snap.source` is `"live"`.
5. **Restrict the Helius key.** It now lives only on Vercel's servers, but lock it down anyway:
   - In the Helius dashboard, limit it to devnet.
   - Set a credit or rate cap.
   - Don't reuse it for anything else.
   - If it ever shipped in a public bundle (the old Pages build inlined `VITE_RPC_URL`), rotate it.

`.github/workflows/web.yml` runs `npm ci`, the tests and the build on every change under `web/`. It also fails if `.next/static` contains an RPC key.

## Layout

| Path | Role |
|---|---|
| `app/` | Routes, the root layout (fonts, server-side snapshot) and `globals.css` (OKLCH tokens, light and dark) |
| `app/api/` | `rpc` proxy, `snapshot`, `decisions` |
| `src/components/` | Client components: `console.tsx` (session, keys, header), one file per page, `ui.tsx` |
| `src/lib/` | The program client (`vetowall.ts`), Token-2022 (`token.ts`), records, report, the RPC proxy, the server snapshot and browser-side signing (`chain.ts`) |
