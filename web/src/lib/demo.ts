// Seeded, read-only sample data, shown only when the live devnet issuer can't
// be read, so no page is ever empty. The issuer is deliberately fake
// ("Sample Dollar", SAMPLE) and every page badges it as sample data. Times are
// relative to `now` so countdowns keep moving. Uses the production delays
// (48h/72h/7d).
import type { Action, Decision, Snapshot } from './model.ts';

const H = 3600, D = 86400;

const deployment: Snapshot['deployment'] = {
  config: '2HfenVnkWZ52twQjqjH1pk2UfKQGTvzKxC6x1KfZn4bh',
  authority: '6mciMunNJsZYyYgJHVTUQdCNUhoriaBCakvD4JA11bq',
  mint: '4Ys2hbtxpanVcgcvX9amjTTL92yeAFQgbLdCHbddaaAT',
  symbol: 'SAMPLE',
  decimals: 6,
  proposer: 'Gza9mpV9c8X6uTk2pzzrS2ZbvY6FtN3rtHwaQVnk4nQA',
  approver: 'Dp7LjDs5TjwtZP3kz5QLNyz75Bn6Edxdrck822dyYkt5',
  guardian: '7Jgc1HrQCNgk4jsQS3jdjD2tSiSX6sMxLD7Dvxg3gTAS',
  attestor: 'BNnLrQftFXexFFR6UFmJX8PszgKqUM2svCjJZEJXTWB9',
  delays: [0, 2 * D, 3 * D, 7 * D],
};
const { proposer: maker, approver: checker } = deployment;
const treasury = '8hys3u6AcvoWkSCq3Ha9i3FMWF1csCoHUDqHpR7sBxuv';

const VETO_80M =
  'Proposal #3 would mint 80,000,000 SAMPLE. Supply would reach 97,000,000 against 32,000,000 SAMPLE of attested reserves, so 65,000,000 SAMPLE would be unbacked. Vetoed under the rule that every mint must be fully backed.';
const VETO_AUTH =
  'Proposal #2 would move the mint authority from the Vetowall authority PDA to an outside wallet (9KUT...3Smw). That wallet could then mint without approval, timelock or reserve checks. Vetoed under the rule that no authority may leave Vetowall.';
// sha256 of the texts above; the Guardian page re-checks them in the browser.
const HASH_80M = '05366b9a7903d1d908bb6e8ad4f6726170dde63f93f4b911e60b0391d9d458a8';
const HASH_AUTH = '4cee3db5ae766272eea1306d48045faacdb2217a5ea8256724d3473b4c1b545c';

const nowSecs = () => Math.floor(Date.now() / 1000);

export function demoSnapshot(now = nowSecs()): Snapshot {
  const t = (secs: number) => now + secs;
  const seeded: Action[] = [
    { id: 0, address: '7sBUvfe8WezPvxZHAUJFMXK2QTijFA6LPsqWwE5ggs2U', path: 'timelock', action: 'Mint', subject: treasury, amount: 15_000_000, class: 'Params', status: 'executed', queuedAt: t(-9 * D), eta: t(-7 * D), maker, checker, note: 'Initial issuance, above the daily cap so it waited 48h' },
    { id: null, path: 'fast lane', action: 'Mint', subject: treasury, amount: 2_000_000, class: 'Params', status: 'executed', queuedAt: t(-6 * D), eta: t(-6 * D), maker, checker, tx: '337wizaTSR479SRxB3QjLbMjkSrMcv7yyfqSrzUTk5Z5g56WDLGkYefZp83g3YXst6GYQEQBDNpRyarW1odh5Jw4' },
    { id: 1, address: '2UNRGfq4NmkU9T5arJorFoauduk43jHYmCBhJR2nrgL3', path: 'timelock', action: 'Freeze account', subject: 'GJgra5Zhh9AzKBqgyaz3YqJYS9S4RBwQVUopaVmqpJJz', class: 'Params', status: 'executed', queuedAt: t(-5 * D), eta: t(-3 * D), maker, checker, note: 'Sanctions screening hit' },
    { id: 2, address: '28TG1X2n2iaDWAJ7tqSMkrV4rycUNZd6S53aqozwxVyB', path: 'timelock', action: 'Change mint authority', subject: '9KUTzrqXjH44ZSgFCUfbvxWw4imNhhBCqYVNKWQY3Smw', class: 'Max', status: 'vetoed', queuedAt: t(-4 * D), eta: t(3 * D), maker, checker, vetoReason: HASH_AUTH, note: 'Authority would leave Vetowall' },
    { id: 3, address: '8MoUVdAyeV7tEdopF8h1g7dCdvWqJZXMPbbUqMRDenxE', path: 'timelock', action: 'Mint', subject: treasury, amount: 80_000_000, class: 'Params', status: 'vetoed', queuedAt: t(-3 * D), eta: t(-1 * D), maker, checker, vetoReason: HASH_80M, note: 'Unbacked: 65M above attested reserves' },
    { id: null, path: 'fast lane', action: 'Mint', subject: treasury, amount: 300_000_000_000_000, class: 'Params', status: 'refused', queuedAt: t(-2 * D), eta: t(-2 * D), maker, checker, tx: '49wFWccXMqqpg8bZvEpUsEs4B4TSVoiCqc9tFMKBF8eZMAVD15FkxezFCLD5W7Nia3U3zHcFdgiLVNcZKkutvCRt', note: 'Refused onchain (OverReserves): fat-finger, far above reserves and 30,000,000x the daily cap' },
    { id: null, path: 'guardian', action: 'Pause transfers', class: 'Safe', status: 'executed', queuedAt: t(-2 * D + 600), eta: t(-2 * D + 600), maker: deployment.guardian, tx: 'ZFjdm6HjK88Mnsiv5HP1PULKgkZXPvb6dkjj2CHRzx6cgxECrFByWqnorMqshYqhLqRxzHgL6Ak4qRYVMe7xdaZ', note: 'Guardian paused while the 300T attempt was reviewed' },
    { id: 4, address: 'AueCjmHPbZKwiP7qSiWHgCJxdCqQFSCZreZm8RQ56uuW', path: 'timelock', action: 'Resume transfers', class: 'Params', status: 'executed', queuedAt: t(-50 * H), eta: t(-2 * H), maker, checker },
    { id: null, path: 'fast lane', action: 'Mint', subject: treasury, amount: 3_000_000, class: 'Params', status: 'executed', queuedAt: t(-20 * H), eta: t(-20 * H), maker, checker, tx: '2UAJPr5rYHWRLmtueEWN55YX6yKPzGpADNg6D3LYbTiXDUW6vJsw3CEveP3HMoN4XuRMaGKgeG7cuci1S3mSpMCm' },
    { id: null, path: 'fast lane', action: 'Mint', subject: treasury, amount: 1_500_000, class: 'Params', status: 'executed', queuedAt: t(-3 * H), eta: t(-3 * H), maker, checker, tx: '6U1DxfqboxF95gjYUZ58XoJkSwGQvqBtF1CSbSfinWgmWW5VhtWyqarzgMMYnRWwraDcShr1utFnbKPopuXTti4' },
    { id: 5, address: '9KUTzrqXjH44ZSgFCUfbvxWw4imNhhBCqYVNKWQY3Smw', path: 'timelock', action: 'Mint', subject: treasury, amount: 12_000_000, class: 'Params', status: 'queued', queuedAt: t(-17 * H), eta: t(31 * H), maker, checker, note: 'Above the remaining daily cap' },
    { id: 6, address: '6jZ3qDysoxGq1mKba65bT3vwnTVLYkxnkZ7PZwbxptc3', path: 'timelock', action: 'Burn (permanent delegate)', subject: 'GJgra5Zhh9AzKBqgyaz3YqJYS9S4RBwQVUopaVmqpJJz', amount: 250_000, class: 'Authority', status: 'queued', queuedAt: t(-14 * H), eta: t(58 * H), maker, checker, note: 'Court-ordered seizure' },
  ];
  // Executed proposals ran a few minutes after their timelock ended; the rest ran when recorded.
  const actions = seeded.map((a) =>
    a.status === 'executed' ? { ...a, executedAt: a.path === 'timelock' ? a.eta + 240 : a.queuedAt } : a,
  );
  return {
    source: 'demo',
    deployment,
    actions,
    supply: 21_500_000,
    reserve: { amount: 32_000_000, updatedAt: t(-3 * H), maxAge: D },
    cap: { cap: 10_000_000, used: 4_500_000, windowStart: t(-21 * H), window: D },
    authorities: [
      'Mint', 'Freeze', 'Permanent delegate', 'Pause', 'Metadata pointer', 'Metadata update', 'Close mint',
    ].map((name) => ({ name, holder: deployment.authority })),
    paused: false,
  };
}

export function demoDecisions(now = nowSecs()): Decision[] {
  const iso = (secs: number) => new Date((now + secs) * 1000).toISOString();
  return [
    { ts: iso(-3 * D + 240), proposal: '8MoUVdAyeV7tEdopF8h1g7dCdvWqJZXMPbbUqMRDenxE', id: 3, rule: 'mint_exceeds_reserves', explanation: VETO_80M, reason_hash: HASH_80M, veto_tx: '2NdREXTZEkhswUbyRpD4pQzczZgx5inppX3G1XzHRi9pwGdsCpDgrWoj9nfLQctkjh9tfsUFoBQsZx4TEzWVU4y1' },
    { ts: iso(-4 * D + 180), proposal: '28TG1X2n2iaDWAJ7tqSMkrV4rycUNZd6S53aqozwxVyB', id: 2, rule: 'authority_leaves_vetowall', explanation: VETO_AUTH, reason_hash: HASH_AUTH, veto_tx: '4RbmDPByn5cy9whfNwqPkg6HYQxkvcY2jRXGcvPGA77Hu3hjBDTyXSHwCqv7kkXHw6mjwbj2smNcVzTxevJc5B2L' },
  ];
}
