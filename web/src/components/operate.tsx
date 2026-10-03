'use client';
import { useState, type ReactNode } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { connection, prepare, run, send } from '@/src/lib/chain';
import { fmtAmount, fmtDuration, fmtShort, fmtTime, godKeys, type Action, type Path, type Snapshot } from '@/src/lib/model';
import { ata, mintToIx } from '@/src/lib/token';
import { attestIx, executeIx, executeNowIx, pda, queueIx } from '@/src/lib/vetowall';
import { useConsole, useNow } from './console';
import { Addr, Bar, Icon, Mark, PageHead, Panel, Stat, TaskStatus, short, useTask } from './ui';

const U64_MAX = 2n ** 64n - 1n;

function toBase(amount: number, decimals: number): bigint {
  const [whole, frac = ''] = amount.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: decimals }).split('.');
  const base = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  if (base > U64_MAX) throw new Error(`${fmtShort(amount)} doesn't fit in a u64 at ${decimals} decimals. The program can't even encode it.`);
  return base;
}

type Lane = 'fast' | 'queue';
interface Pending {
  tx: Transaction;
  lane: Lane;
  amount: number;
  approved: boolean;
}

const PATH_LABELS: Record<Path, string> = {
  'fast lane': 'Fast lane', timelock: 'Timelock', guardian: 'Guardian action', attestor: 'Reserve attestation', governance: 'Config change',
};

function Timeline({ snap, actionFor }: { snap: Snapshot; actionFor?: (a: Action, now: number) => ReactNode }) {
  const now = useNow();
  const live = snap.source === 'live';
  const rows = [...snap.actions].sort((a, b) => b.queuedAt - a.queuedAt || (a.seq ?? 0) - (b.seq ?? 0));
  if (!rows.length) return <p className="note">No actions yet. Propose a mint above and it will show up here.</p>;
  return (
    <ol className="timeline">
      {rows.map((a, i) => {
        const left = a.eta - now;
        return (
          <li key={`${a.id}-${a.tx}-${a.seq}-${i}`} className="tl">
            <div>
              <div className="tl-title">
                <Mark status={a.status} />
                <strong>
                  {a.action}
                  {a.amount !== undefined && ` ${a.amount >= 1e9 ? fmtShort(a.amount) : fmtAmount(a.amount)} ${snap.deployment.symbol}`}
                </strong>
              </div>
              <div className="tl-meta">
                {a.id !== null ? `Proposal #${a.id}` : PATH_LABELS[a.path]} · {a.class && `${a.class} class · `}
                {fmtTime(a.queuedAt)}
                {a.subject && <> · <Addr value={a.subject} live={live} /></>}
              </div>
              {a.note && <div className="tl-note">{a.note}</div>}
            </div>
            <div className="tl-side">
              {a.status === 'queued' &&
                (left > 0 ? (
                  <span className="countdown">Runs in {fmtDuration(left)}</span>
                ) : (
                  <span className="countdown ready">Ready to execute</span>
                ))}
              {actionFor?.(a, now)}
              {a.address ? <Addr value={a.address} live={live} /> : a.tx ? <Addr value={a.tx} kind="tx" live={live} /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default function Operate() {
  const ctx = useConsole();
  const { snap, keys } = ctx;
  const d = snap.deployment;
  // A shared demo config only accepts its own proposer; launch your own token to drive it.
  const canAct = ctx.canAct && keys?.operator.publicKey.toBase58() === d.proposer && keys.approver.publicKey.toBase58() === d.approver;
  const canAttest = ctx.canAct && keys?.attestor.publicKey.toBase58() === d.attestor;
  const live = snap.source === 'live';
  const now = useNow();
  const task = useTask();
  const [amount, setAmount] = useState(1_000_000);
  const [lane, setLane] = useState<Lane | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  // Starts from the reserve figure currently attested onchain.
  const [attestInput, setAttest] = useState<number | null>(null);
  const attest = attestInput ?? snap.reserve?.amount ?? 0;

  const capLeft = snap.cap ? Math.max(0, snap.cap.cap - snap.cap.used) : Infinity;
  const reserveLeft = snap.reserve ? snap.reserve.amount - snap.supply : Infinity;
  const stale = !!snap.reserve && now - snap.reserve.updatedAt > snap.reserve.maxAge;
  const autoLane: Lane = amount <= capLeft ? 'fast' : 'queue';
  const chosen = lane ?? autoLane;
  const verdict = snap.paused
    ? { tone: 'bad', icon: 'stop', text: 'The mint is paused. Token-2022 refuses every mint until a Resume proposal executes.' }
    : amount > reserveLeft
      ? { tone: 'bad', icon: 'x', text: `Over attested reserves by ${fmtShort(amount - reserveLeft)} ${d.symbol}. The program refuses this on every path.` }
      : stale
        ? { tone: 'bad', icon: 'x', text: 'The reserve attestation is older than its max age. The program refuses mints until it is refreshed.' }
        : amount > capLeft
          ? { tone: 'warn', icon: 'clock', text: `Over today's remaining fast-lane cap (${fmtShort(capLeft)}). It must be queued and wait ${fmtDuration(d.delays[1])}.` }
          : { tone: 'good', icon: 'check', text: 'Fits the fast lane: it runs as soon as the checker signs.' };
  const waiting = snap.actions.filter((a) => a.status === 'queued').length;
  const reservePda = live ? pda.reserve(new PublicKey(d.config), new PublicKey(d.mint)) : null;
  const gods = godKeys(snap);

  async function propose() {
    if (!keys) return;
    const op = keys.operator.publicKey;
    const config = new PublicKey(d.config);
    const mint = new PublicKey(d.mint);
    const ix = mintToIx(mint, ata(op, mint), new PublicKey(d.authority), toBase(amount, d.decimals));
    const roles = { config, proposer: op, approver: keys.approver.publicKey };
    const outer = chosen === 'fast' ? await executeNowIx(roles, ix, reservePda) : await queueIx(connection(), roles, ix);
    const [tx] = await keys.operator.sign([await prepare(new Transaction().add(outer), op)]);
    setPending({ tx, lane: chosen, amount, approved: false });
    return 'Proposed and signed by the maker. Waiting for the checker.';
  }

  async function approve() {
    if (!keys || !pending) return;
    await keys.approver.sign([pending.tx]);
    setPending({ ...pending, approved: true });
    return 'Approved by the checker. Ready to submit.';
  }

  async function submit() {
    if (!pending || !keys) return;
    setPending(null);
    try {
      // A refused fast-lane mint is sent anyway, so the refusal is recorded onchain.
      await send(pending.tx, pending.lane === 'fast');
      return pending.lane === 'fast' ? `Minted ${fmtAmount(pending.amount)} ${d.symbol}.` : 'Queued. The countdown is in the timeline below.';
    } finally {
      await ctx.refresh();
    }
  }

  const step = !pending ? 0 : pending.approved ? 2 : 1;
  const why = !keys
    ? 'Use demo keys or connect Phantom, then launch your own token to mint.'
    : !ctx.canAct
      ? 'Launch a token first: actions need a live deployment.'
      : "Your keys aren't this issuer's maker and checker. Launch your own token to mint.";

  return (
    <div className="container page">
      <PageHead title="Operate">
        Every mint needs two people: a maker proposes, a checker approves. Small mints run at once inside a daily cap. Larger ones wait out a
        timelock the guardian can veto. No mint can push supply above attested reserves.
      </PageHead>
      <div className="stats">
        <Stat label="Supply" value={<>{fmtShort(snap.supply)} <small>{d.symbol}</small></>} sub={fmtAmount(snap.supply)} />
        <Stat
          label="Attested reserves"
          value={snap.reserve ? fmtShort(snap.reserve.amount) : 'None'}
          tone={stale ? 'warn' : undefined}
          sub={snap.reserve ? `${stale ? 'Stale · ' : ''}updated ${fmtDuration(now - snap.reserve.updatedAt)} ago` : 'Not attested'}
        />
        <Stat
          label="Fast lane today"
          value={snap.cap ? <>{fmtShort(snap.cap.used)} <small>/ {fmtShort(snap.cap.cap)}</small></> : 'No cap'}
          sub={snap.cap && <Bar value={snap.cap.used} max={snap.cap.cap} label={`${fmtAmount(snap.cap.used)} of ${fmtAmount(snap.cap.cap)} used`} />}
        />
        <Stat label="God keys" value={gods} tone={gods ? 'bad' : 'good'} sub="Authorities held by a person" />
        <Stat label="In timelock" value={waiting} sub={snap.paused ? 'Transfers paused' : 'Transfers active'} />
      </div>
      <div className="grid-2">
        <Panel id="mint-title" title="Mint with maker-checker">
          <form className="form" onSubmit={(e) => e.preventDefault()}>
            <label className="field">
              Amount ({d.symbol})
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={amount}
                aria-describedby="verdict"
                onChange={(e) => {
                  setAmount(Number(e.target.value));
                  setPending(null);
                }}
              />
            </label>
            <p id="verdict" className={`verdict verdict-${verdict.tone}`} role="status">
              <Icon name={verdict.icon as 'check'} /> <span>{verdict.text}</span>
            </p>
            <fieldset>
              <legend>Path</legend>
              <label className="choice"><input type="radio" name="lane" checked={chosen === 'fast'} onChange={() => setLane('fast')} /> Fast lane (execute now)</label>
              <label className="choice"><input type="radio" name="lane" checked={chosen === 'queue'} onChange={() => setLane('queue')} /> Timelock (queue)</label>
            </fieldset>
            <ol className="flow" aria-label="Maker-checker steps">
              <li>
                <button type="button" className={`btn ${step === 0 ? 'btn-primary' : ''}`} disabled={!canAct || step !== 0 || !!task.busy} onClick={() => task.run('Signing as maker', propose)}>
                  {step > 0 && <Icon name="check" />} 1. Propose
                </button>
                <span>Maker {keys ? short(keys.operator.publicKey.toBase58()) : short(d.proposer)}</span>
              </li>
              <li>
                <button type="button" className={`btn ${step === 1 ? 'btn-primary' : ''}`} disabled={step !== 1 || !!task.busy} onClick={() => task.run('Signing as checker', approve)}>
                  {step > 1 && <Icon name="check" />} 2. Approve
                </button>
                <span>Checker {keys ? short(keys.approver.publicKey.toBase58()) : d.approver && short(d.approver)}</span>
              </li>
              <li>
                <button type="button" className={`btn ${step === 2 ? 'btn-primary' : ''}`} disabled={step !== 2 || !!task.busy} onClick={() => task.run('Submitting', submit)}>
                  3. {pending?.lane === 'queue' ? 'Queue' : 'Execute now'}
                </button>
                <span>{pending?.lane === 'queue' ? `Runs after ${fmtDuration(d.delays[1])}` : 'Both signatures, one transaction'}</span>
              </li>
            </ol>
            {!canAct && (
              <p className="note">
                Read-only: {why} The checks above still work: try 80000000 or 300000000000000.
              </p>
            )}
          </form>
          <TaskStatus task={task} />
        </Panel>
        <Panel id="reserve-title" title="Reserve attestation">
          {snap.reserve ? (
            <dl className="kv">
              <dt>Attested reserves</dt>
              <dd>{fmtAmount(snap.reserve.amount)} {d.symbol}</dd>
              <dt>Supply</dt>
              <dd>{fmtAmount(snap.supply)} {d.symbol}</dd>
              <dt>Headroom</dt>
              <dd>{fmtAmount(Math.max(0, reserveLeft))} {d.symbol}</dd>
              <dt>Last attested</dt>
              <dd>
                {fmtTime(snap.reserve.updatedAt)}{' '}
                {/* "Refused" is an outcome of a transaction; an old attestation is stale, which is why mints get refused. */}
                {stale && (
                  <span className="mark mark-refused">
                    <Icon name="clock" size={12} />
                    Stale
                  </span>
                )}
              </dd>
              <dt>Max age</dt>
              <dd>{fmtDuration(snap.reserve.maxAge)}</dd>
              {d.attestor && (
                <>
                  <dt>Attestor</dt>
                  <dd><Addr value={d.attestor} live={live} /></dd>
                </>
              )}
            </dl>
          ) : (
            <p className="note">No reserve account yet.</p>
          )}
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              task.run('Attesting reserves', async () => {
                if (!keys) return;
                const ix = await attestIx(new PublicKey(d.config), new PublicKey(d.mint), keys.attestor.publicKey, toBase(attest, d.decimals));
                await run(new Transaction().add(ix), [keys.operator, keys.attestor]);
                await ctx.refresh();
                return `Attested ${fmtAmount(attest)} ${d.symbol}.`;
              });
            }}
          >
            <label className="field">
              New attestation ({d.symbol})
              <input type="number" inputMode="decimal" min={0} step="any" value={attest} onChange={(e) => setAttest(Number(e.target.value))} />
              <span className="help">Starts at the figure attested onchain now.</span>
            </label>
            <div className="actions">
              <button className="btn" disabled={!canAttest || !!task.busy}>Attest as attestor</button>
            </div>
            {!canAttest && <p className="note">Only this issuer&rsquo;s attestor key can attest. Launch your own token to try it.</p>}
          </form>
          <p className="note">In production the attestor is the custodian&rsquo;s or auditor&rsquo;s key. Mints check against this figure onchain.</p>
        </Panel>
      </div>
      <Panel id="timeline-title" title="Proposals and records" aside={<span className="muted small">Newest first</span>}>
        <Timeline
          snap={snap}
          actionFor={(a, t) =>
            ctx.canAct && a.status === 'queued' && a.address && t >= a.eta ? (
              <button
                className="btn btn-primary btn-sm"
                disabled={!!task.busy}
                onClick={() =>
                  task.run(`Executing proposal #${a.id}`, async () => {
                    const ix = await executeIx(connection(), new PublicKey(d.config), new PublicKey(a.address!), reservePda);
                    await run(new Transaction().add(ix), [keys!.operator]);
                    await ctx.refresh();
                    return `Proposal #${a.id} executed.`;
                  })
                }
              >
                Execute #{a.id}
              </button>
            ) : null
          }
        />
      </Panel>
    </div>
  );
}
