import { useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import type { Ctx } from '../App';
import { appendLog, prepare, run, send } from '../chain';
import { fmtAmount, fmtDuration, fmtShort, godKeys, type Action } from '../model';
import { ata, mintToIx } from '../token';
import { Addr, Card, Stat, TaskStatus, Timeline, short, useNow, useTask } from '../ui';
import { attestIx, executeIx, executeNowIx, pda, queueIx } from '../vetowall';

const U64_MAX = 2n ** 64n - 1n;

export function toBase(amount: number, decimals: number): bigint {
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
  dest: string;
  approved: boolean;
}

export default function Operate({ ctx }: { ctx: Ctx }) {
  const { snap, keys, canAct } = ctx;
  const d = snap.deployment;
  const live = snap.source === 'live';
  const now = useNow();
  const task = useTask();
  const [amount, setAmount] = useState(2_000_000);
  const [lane, setLane] = useState<Lane | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [attest, setAttest] = useState(snap.reserve?.amount ?? 0);

  const capLeft = snap.cap ? Math.max(0, snap.cap.cap - snap.cap.used) : Infinity;
  const reserveLeft = snap.reserve ? snap.reserve.amount - snap.supply : Infinity;
  const stale = !!snap.reserve && now - snap.reserve.updatedAt > snap.reserve.maxAge;
  const autoLane: Lane = amount <= capLeft ? 'fast' : 'queue';
  const chosen = lane ?? autoLane;
  const verdict =
    amount > reserveLeft
      ? { tone: 'bad', text: `Over attested reserves by ${fmtShort(amount - reserveLeft)} ${d.symbol}. The program refuses this on every path.` }
      : stale
        ? { tone: 'bad', text: 'The reserve attestation is older than its max age. The program refuses mints until it is refreshed.' }
        : amount > capLeft
          ? { tone: 'warn', text: `Over today's remaining fast-lane cap (${fmtShort(capLeft)}). It must be queued and wait ${fmtDuration(d.delays[1])}.` }
          : { tone: 'good', text: 'Fits the fast lane: it runs as soon as the approver signs.' };
  const waiting = snap.actions.filter((a) => a.status === 'queued').length;
  const reservePda = live ? pda.reserve(new PublicKey(d.config), new PublicKey(d.mint)) : null;

  async function propose() {
    if (!keys) return;
    const op = keys.operator.publicKey;
    const config = new PublicKey(d.config);
    const mint = new PublicKey(d.mint);
    const dest = ata(op, mint);
    const ix = mintToIx(mint, dest, new PublicKey(d.authority), toBase(amount, d.decimals));
    const roles = { config, proposer: op, approver: keys.approver.publicKey };
    const outer = chosen === 'fast' ? await executeNowIx(roles, ix, reservePda) : await queueIx(roles, ix);
    const [tx] = await keys.operator.sign([await prepare(new Transaction().add(outer), op)]);
    setPending({ tx, lane: chosen, amount, dest: dest.toBase58(), approved: false });
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
    const record: Action = {
      id: null, path: 'fast lane', action: 'Mint', subject: pending.dest, amount: pending.amount, class: 'Params',
      status: 'executed', queuedAt: Math.floor(Date.now() / 1000), eta: Math.floor(Date.now() / 1000),
      maker: keys.operator.publicKey.toBase58(), checker: keys.approver.publicKey.toBase58(),
    };
    setPending(null);
    try {
      const sig = await send(pending.tx);
      if (pending.lane === 'fast') appendLog(d.config, { ...record, tx: sig });
      await ctx.refresh();
      return pending.lane === 'fast' ? `Minted ${fmtAmount(pending.amount)} ${d.symbol}.` : 'Queued. The countdown is in the timeline below.';
    } catch (e) {
      if (pending.lane === 'fast') appendLog(d.config, { ...record, status: 'refused', note: `Refused onchain: ${(e as Error).message}` });
      await ctx.refresh();
      throw e;
    }
  }

  const step = !pending ? 0 : pending.approved ? 2 : 1;

  return (
    <>
      <div className="page-head">
        <h1>Operate</h1>
        <p className="lede">
          Every mint needs two people: a maker proposes, a checker approves. Small mints run at once inside a daily cap. Larger ones wait
          out a timelock the guardian can veto. No mint can push supply above attested reserves.
        </p>
      </div>
      <div className="stats">
        <Stat label="Supply" value={`${fmtShort(snap.supply)} ${d.symbol}`} sub={fmtAmount(snap.supply)} />
        <Stat
          label="Attested reserves"
          value={snap.reserve ? `${fmtShort(snap.reserve.amount)}` : 'None'}
          sub={snap.reserve ? `${stale ? 'Stale · ' : ''}updated ${fmtDuration(now - snap.reserve.updatedAt)} ago` : 'Not attested'}
          tone={stale ? 'warn' : 'good'}
        />
        <Stat
          label="Fast lane today"
          value={snap.cap ? `${fmtShort(snap.cap.used)} / ${fmtShort(snap.cap.cap)}` : 'No cap'}
          sub={snap.cap && <meter min={0} max={snap.cap.cap} value={snap.cap.used} aria-label="Daily cap used" />}
        />
        <Stat label="God keys" value={godKeys(snap)} sub="authorities held by a person" tone={godKeys(snap) ? 'warn' : 'good'} />
        <Stat label="In timelock" value={waiting} sub={snap.paused ? 'Transfers paused' : 'Transfers active'} />
      </div>
      <div className="grid-2">
        <Card title="Mint with maker-checker">
          <form className="form" onSubmit={(e) => e.preventDefault()}>
            <label>
              Amount ({d.symbol})
              <input
                type="number"
                min={0}
                step="any"
                value={amount}
                onChange={(e) => {
                  setAmount(Number(e.target.value));
                  setPending(null);
                }}
              />
            </label>
            <p className={`verdict verdict-${verdict.tone}`}>{verdict.text}</p>
            <fieldset className="lanes">
              <legend>Path</legend>
              <label><input type="radio" name="lane" checked={chosen === 'fast'} onChange={() => setLane('fast')} /> Fast lane (execute now)</label>
              <label><input type="radio" name="lane" checked={chosen === 'queue'} onChange={() => setLane('queue')} /> Timelock (queue)</label>
            </fieldset>
            <ol className="flow">
              <li className={step > 0 ? 'done' : ''}>
                <button type="button" className="btn btn-primary" disabled={!canAct || step !== 0 || !!task.busy} onClick={() => task.run('Signing as maker', propose)}>
                  1. Propose
                </button>
                <span>Maker {keys ? short(keys.operator.publicKey.toBase58()) : short(d.proposer)}</span>
              </li>
              <li className={step > 1 ? 'done' : ''}>
                <button type="button" className="btn" disabled={step !== 1 || !!task.busy} onClick={() => task.run('Signing as checker', approve)}>
                  2. Approve
                </button>
                <span>Checker {keys ? short(keys.approver.publicKey.toBase58()) : d.approver && short(d.approver)}</span>
              </li>
              <li>
                <button type="button" className="btn" disabled={step !== 2 || !!task.busy} onClick={() => task.run('Submitting', submit)}>
                  3. {pending?.lane === 'queue' ? 'Queue' : 'Execute now'}
                </button>
                <span>{pending?.lane === 'queue' ? `Runs after ${fmtDuration(d.delays[1])}` : 'Both signatures, one transaction'}</span>
              </li>
            </ol>
            {!canAct && <p className="note">Read-only: {!keys ? 'connect a wallet or use demo keys' : 'launch a token first'} to mint. The checks above still work. Try 80000000 or 300000000000000.</p>}
          </form>
          <TaskStatus task={task} />
        </Card>
        <Card title="Reserve attestation">
          {snap.reserve ? (
            <dl className="kv">
              <dt>Attested reserves</dt><dd>{fmtAmount(snap.reserve.amount)} {d.symbol}</dd>
              <dt>Supply</dt><dd>{fmtAmount(snap.supply)} {d.symbol}</dd>
              <dt>Headroom</dt><dd>{fmtAmount(Math.max(0, reserveLeft))} {d.symbol}</dd>
              <dt>Last attested</dt><dd>{fmtDuration(now - snap.reserve.updatedAt)} ago {stale && <span className="pill pill-vetoed">stale</span>}</dd>
              <dt>Max age</dt><dd>{fmtDuration(snap.reserve.maxAge)}</dd>
              {d.attestor && <><dt>Attestor</dt><dd><Addr value={d.attestor} live={live} /></dd></>}
            </dl>
          ) : (
            <p className="note">No reserve account yet.</p>
          )}
          <form
            className="form inline"
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
            <label>
              New attestation ({d.symbol})
              <input type="number" min={0} step="any" value={attest} onChange={(e) => setAttest(Number(e.target.value))} />
            </label>
            <button className="btn" disabled={!canAct || !!task.busy}>Attest as attestor</button>
          </form>
          <p className="note">In production the attestor is the custodian's or auditor's key. Mints check against this figure onchain.</p>
        </Card>
      </div>
      <Card title="Proposals timeline" aside={<span className="muted">Newest first</span>}>
        <Timeline
          snap={snap}
          actionFor={(a, t) =>
            canAct && a.status === 'queued' && a.address && t >= a.eta ? (
              <button
                className="btn btn-primary btn-sm"
                disabled={!!task.busy}
                onClick={() =>
                  task.run(`Executing proposal #${a.id}`, async () => {
                    const ix = await executeIx(new PublicKey(d.config), new PublicKey(a.address!), reservePda);
                    await run(new Transaction().add(ix), [keys!.operator]);
                    await ctx.refresh();
                    return `Proposal #${a.id} executed.`;
                  })
                }
              >
                Execute
              </button>
            ) : null
          }
        />
      </Card>
    </>
  );
}
