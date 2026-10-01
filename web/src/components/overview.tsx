'use client';
import Link from 'next/link';
import { explorer } from '@/src/lib/explorer';
import { fmtAmount, fmtDuration, fmtShort, fmtTime, godKeys, type Action, type Snapshot } from '@/src/lib/model';
import { useConsole, useNow } from './console';
import { Addr, Bar, Mark, SourceBadge, Stat, short } from './ui';

const latest = (xs: Action[], by: (a: Action) => number) => xs.reduce<Action | undefined>((m, a) => (!m || by(a) > by(m) ? a : m), undefined);
const isMint = (a: Action) => a.action.startsWith('Mint');

interface Event {
  key: string;
  title: string;
  action?: Action;
  story: (a: Action, s: Snapshot) => string;
}

/** The four moments that tell the story, picked from the onchain record (or the sample data). */
function keyEvents(s: Snapshot): Event[] {
  const xs = s.actions;
  const amt = (a: Action) => `${fmtAmount(a.amount ?? 0)} ${s.deployment.symbol}`;
  return [
    {
      key: 'refused',
      title: 'Unbacked mint refused',
      action: latest(xs.filter((a) => isMint(a) && a.status === 'refused'), (a) => a.amount ?? 0),
      story: (a) =>
        `A mint of ${amt(a)} would have pushed supply past attested reserves. The program refused it on the fast lane${
          a.note?.match(/\((\w+)\)/)?.[1] ? ` with ${a.note.match(/\((\w+)\)/)![1]}` : ''
        }; the failed transaction is the record.`,
    },
    {
      key: 'vetoed',
      title: 'Authority change vetoed',
      action: latest(xs.filter((a) => a.status === 'vetoed' && /authority/i.test(a.action)), (a) => a.queuedAt),
      story: (a) =>
        `A proposal to move the mint authority to an outside wallet was vetoed by the guardian while it sat in its ${a.class ?? 'Max'} timelock. It can never execute.`,
    },
    {
      key: 'timelock',
      title: 'Large mint waited out its timelock',
      action: latest(xs.filter((a) => isMint(a) && a.path === 'timelock' && a.status === 'executed'), (a) => a.executedAt ?? 0),
      story: (a) =>
        `${amt(a)} was above the daily fast-lane cap, so maker and checker queued it. It waited ${fmtDuration(a.eta - a.queuedAt)}, open to veto, then executed${
          a.executedAt ? ` at ${fmtTime(a.executedAt)}` : ''
        }.`,
    },
    {
      key: 'fast',
      title: 'Routine mint on the fast lane',
      action: latest(xs.filter((a) => isMint(a) && a.path === 'fast lane' && a.status === 'executed'), (a) => a.queuedAt),
      story: (a) => `${amt(a)}, inside the daily cap and within reserves. Maker and checker signed one transaction and it ran at once.`,
    },
  ];
}

const STEPS = [
  ['Hand over the authorities', 'Launch a Token-2022 mint with all seven authorities on Vetowall’s program address, in the same transaction. No person ever holds one.'],
  ['Classify every action', 'Each admin instruction is Safe, Params, Authority or Max, and each class has its own timelock. Anything unregistered is Max.'],
  ['Bound every mint', 'A maker proposes and a checker approves. Routine mints run inside a daily cap; larger ones wait out the timelock. Nothing mints above attested reserves.'],
  ['Watch, veto, report', 'A guardian can veto a queued proposal or pause transfers, and nothing else. Every action leaves an onchain change record, exported as a compliance report.'],
];

const PATHS = [
  ['/operate', 'Operate', 'Propose a mint as maker, approve it as checker, and watch the cap, timelock and reserve checks decide.'],
  ['/comply', 'Comply', 'Export the change-control report as CSV, JSON or print, each column mapped to a control in the OCC’s proposed rule.'],
  ['/launch', 'Launch', 'Create your own devnet token with zero god keys, using demo keys or Phantom. It takes about a minute.'],
];

export default function Overview() {
  const { snap, readAt } = useConsole();
  const now = useNow();
  const live = snap.source === 'live';
  const d = snap.deployment;
  const sym = d.symbol;
  const gods = godKeys(snap);
  const onPda = snap.authorities.filter((a) => a.holder === d.authority).length;
  const queued = snap.actions.filter((a) => a.status === 'queued');
  const next = queued.reduce<number | null>((m, a) => (m === null || a.eta < m ? a.eta : m), null);
  const capResets = snap.cap && snap.cap.windowStart + snap.cap.window - now;
  const headroom = snap.reserve ? snap.reserve.amount - snap.supply : null;

  return (
    <div className="container">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <h1 id="hero-title">The control plane for stablecoin and tokenized-asset issuers on Solana</h1>
          <p className="hero-sub">
            Vetowall holds your Token-2022 authorities in a program, so no single key, human or AI, can mint, freeze or seize outside policy.
          </p>
          <ul className="audience" aria-label="Who it is for">
            <li><strong>Issuers and treasury ops:</strong> maker-checker mints, capped daily and bounded by attested reserves.</li>
            <li><strong>Compliance and audit:</strong> every change is an onchain record, exported as a report.</li>
            <li><strong>Risk teams:</strong> a guardian that can veto or pause, and nothing more.</li>
          </ul>
          <div className="actions">
            <Link className="btn btn-primary" href="/operate">{live ? 'Operate the live issuer' : 'Explore the sample issuer'}</Link>
            {live ? (
              <a className="btn" href={explorer('address', d.mint)} target="_blank" rel="noreferrer">
                Verify the {sym} mint on Explorer
              </a>
            ) : (
              <Link className="btn" href="/launch">Launch your own token</Link>
            )}
          </div>
        </div>

        <section className="proof" aria-labelledby="proof-title">
          <header className="proof-head">
            <h2 id="proof-title">Control status · {sym}</h2>
            <SourceBadge live={live} />
          </header>
          <div className="proof-grid">
            <Stat
              label="God keys"
              value={gods}
              tone={gods ? 'bad' : 'good'}
              sub={`${onPda} of ${snap.authorities.length} mint authorities held by the Vetowall PDA`}
            />
            <Stat
              label="Supply vs attested reserves"
              value={
                <>
                  {fmtShort(snap.supply)} <small>/ {snap.reserve ? fmtShort(snap.reserve.amount) : 'none'}</small>
                </>
              }
              sub={
                snap.reserve ? (
                  <span>
                    {headroom !== null && headroom >= 0 ? `${fmtShort(headroom)} ${sym} headroom` : 'Over reserves'} · attested{' '}
                    {fmtDuration(now - snap.reserve.updatedAt)} ago
                  </span>
                ) : (
                  'No attestation yet'
                )
              }
            />
            <Stat
              label="Fast lane used today"
              value={
                snap.cap ? (
                  <>
                    {fmtShort(snap.cap.used)} <small>/ {fmtShort(snap.cap.cap)}</small>
                  </>
                ) : (
                  'No cap'
                )
              }
              sub={
                snap.cap && (
                  <span className="stack">
                    <Bar value={snap.cap.used} max={snap.cap.cap} label={`${fmtAmount(snap.cap.used)} of ${fmtAmount(snap.cap.cap)} ${sym} used`} />
                    {capResets !== null && capResets > 0 && snap.cap.used > 0 ? `Window resets in ${fmtDuration(capResets)}` : 'Full cap available'}
                  </span>
                )
              }
            />
            <Stat
              label="In timelock"
              value={queued.length}
              sub={next === null ? 'Nothing waiting' : next > now ? `Next can run in ${fmtDuration(next - now)}` : 'One is ready to execute'}
            />
          </div>
          <p className="proof-foot">
            {live ? <>Read from devnet at {fmtTime(readAt)}. </> : <>Sample data, not onchain. </>}
            Mint <Addr value={d.mint} live={live} /> · config <Addr value={d.config} live={live} /> · authority PDA{' '}
            <Addr value={d.authority} live={live} />
          </p>
        </section>
      </section>

      <section className="section" aria-labelledby="record-title">
        <div className="section-head">
          <h2 id="record-title">What the program stopped, and what it let through</h2>
          <p className="muted">
            Drift, Resolv and Paxos each came down to one admin key acting alone. These are the same moves, tried against {sym}
            {live ? ' on devnet. Each row links to its transaction or account on Solana Explorer.' : '. In sample mode the links are turned off.'}
          </p>
        </div>
        <ol className="ledger">
          {keyEvents(snap).map((e) => {
            const a = e.action;
            return (
              <li key={e.key}>
                <div>{a ? <Mark status={a.status} /> : <span className="muted small">Not yet recorded</span>}</div>
                <div className="ledger-body">
                  <h3>
                    {e.title}
                    {a?.amount !== undefined && (
                      <>
                        {' · '}
                        <span className="ledger-amount">
                          {a.amount >= 1e9 ? fmtShort(a.amount) : fmtAmount(a.amount)} {sym}
                        </span>
                      </>
                    )}
                  </h3>
                  <p>{a ? e.story(a, snap) : 'This config has no such record yet.'}</p>
                </div>
                <div className="ledger-proof">
                  {a && (
                    <>
                      <span className="muted">{fmtTime(a.executedAt ?? a.queuedAt)}</span>
                      {a.tx ? (
                        <Addr value={a.tx} kind="tx" live={live} label={live ? `Transaction ${short(a.tx)}` : undefined} />
                      ) : a.address ? (
                        <Addr value={a.address} live={live} label={live ? `Proposal #${a.id} account` : undefined} />
                      ) : null}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="section" aria-labelledby="how-title">
        <div className="section-head">
          <h2 id="how-title">How it works</h2>
          <p className="muted">
            Vetowall sits between whatever signs (a multisig, a single key, an issuance API) and the asset, so its limits hold even if the
            signer is compromised.
          </p>
        </div>
        <ol className="how">
          {STEPS.map(([t, body]) => (
            <li key={t}>
              <h3>{t}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="section" aria-labelledby="try-title">
        <div className="section-head">
          <h2 id="try-title">Try it</h2>
          <p className="muted">No wallet needed to look around. To act, use demo keys (devnet burners) or connect Phantom on devnet.</p>
        </div>
        <div className="paths">
          {PATHS.map(([href, t, body]) => (
            <Link key={href} className="path" href={href}>
              <strong>{t}</strong>
              <span>{body}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
