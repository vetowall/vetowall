import { useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import type { Ctx } from '../App';
import { run } from '../chain';
import { fmtDuration, fmtTime } from '../model';
import { COLUMNS, reportRows, toCSV, toJSON } from '../report';
import { freezeIx } from '../token';
import { Card, Pill, TaskStatus, download, short, useTask } from '../ui';
import { queueIx } from '../vetowall';

export default function Comply({ ctx }: { ctx: Ctx }) {
  const { snap, keys } = ctx;
  const d = snap.deployment;
  const canAct = ctx.canAct && keys?.operator.publicKey.toBase58() === d.proposer;
  const task = useTask();
  const [account, setAccount] = useState('');
  const rows = reportRows(snap);
  const stamp = new Date().toISOString().slice(0, 10);
  const count = (s: string) => rows.filter((r) => r.outcome === s).length;

  async function freeze() {
    if (!keys) return;
    let target: PublicKey;
    try {
      target = new PublicKey(account.trim());
    } catch {
      throw new Error('That is not a valid Solana address.');
    }
    const config = new PublicKey(d.config);
    const ix = await queueIx(
      { config, proposer: keys.operator.publicKey, approver: keys.approver.publicKey },
      freezeIx(target, new PublicKey(d.mint), new PublicKey(d.authority)),
    );
    await run(new Transaction().add(ix), [keys.operator, keys.approver]);
    await ctx.refresh();
    return `Freeze queued. It can run in ${fmtDuration(d.delays[1])}, from the Operate timeline.`;
  }

  return (
    <>
      <div className="page-head">
        <h1>Comply</h1>
        <p className="lede">
          Freezes go through the same maker-checker and timelock as everything else. Every action is an onchain record, and the report
          below exports them with each column tied to a control in the OCC's proposed rule for stablecoin issuers (12 CFR 15.13, risk
          management and operational standards).
        </p>
      </div>
      <div className="grid-2">
        <Card title="Freeze an account via policy">
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              task.run('Queueing freeze', freeze);
            }}
          >
            <label>
              Token account to freeze
              <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Token-2022 account address" required spellCheck={false} />
            </label>
            <p className="note">
              Freeze is a <strong>Params</strong> action: maker and checker both sign, it waits {fmtDuration(d.delays[1])}, and the guardian
              can veto it. Thaw follows the same path.
            </p>
            <button className="btn btn-primary" disabled={!canAct || !!task.busy}>Queue freeze</button>
            {!canAct && <p className="note">Read-only until you connect and launch a token.</p>}
          </form>
          <TaskStatus task={task} />
        </Card>
        <Card title="Change-control report">
          <dl className="kv">
            <dt>Records</dt><dd>{rows.length}</dd>
            <dt>Executed</dt><dd>{count('executed')}</dd>
            <dt>Waiting</dt><dd>{count('queued')}</dd>
            <dt>Vetoed</dt><dd>{count('vetoed')}</dd>
            <dt>Refused</dt><dd>{count('refused')}</dd>
            <dt>Source</dt><dd>{snap.source === 'live' ? 'Onchain change records on devnet' : 'Demo data'}</dd>
          </dl>
          <div className="actions">
            <button className="btn btn-primary" onClick={() => download(`vetowall-change-control-${stamp}.csv`, 'text/csv', toCSV(rows))}>Download CSV</button>
            <button className="btn" onClick={() => download(`vetowall-change-control-${stamp}.json`, 'application/json', toJSON(snap))}>Download JSON</button>
            <button className="btn" onClick={() => print()}>Print</button>
          </div>
        </Card>
      </div>
      <section className="card report" aria-labelledby="report-title">
        <header className="card-head">
          <h2 id="report-title">Change-control report · {d.symbol}</h2>
          <span className="muted">Generated {fmtTime(Date.now() / 1000)}{snap.source === 'demo' && ' · demo data'}</span>
        </header>
        <p className="print-only">
          Program G8LSBa3y5XqY5fK4R6NTK84oPru3W3hsNzRwjunLWedr · config {d.config} · authority PDA {d.authority} · mint {d.mint} · Solana devnet
        </p>
        <div className="scroll">
          <table className="table report-table">
            <thead>
              <tr>
                <th scope="col">Change</th>
                <th scope="col">Requested</th>
                <th scope="col">Action</th>
                <th scope="col">Class / path</th>
                <th scope="col">Maker / checker</th>
                <th scope="col">Wait</th>
                <th scope="col">Outcome</th>
                <th scope="col">Guardian / reserves</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.change_id + r.requested_utc}>
                  <td><code>{r.change_id}</code></td>
                  <td>{r.requested_utc.slice(0, 16).replace('T', ' ')}</td>
                  <td>{r.action}{r.amount && <div className="muted">{Number(r.amount.split(' ')[0]).toLocaleString('en-US')} {d.symbol}</div>}</td>
                  <td>{r.risk_class}<div className="muted">{r.path}</div></td>
                  <td>{r.maker ? <code>{short(r.maker)}</code> : '—'}<div className="muted">{!r.checker ? '—' : r.checker.includes(' ') ? r.checker : <code>{short(r.checker)}</code>}</div></td>
                  <td>{r.waiting_period_hours}h</td>
                  <td><Pill status={r.outcome as 'queued'} /></td>
                  <td className="small">{r.independent_review === 'n/a' ? '' : r.independent_review.replace(/sha256 (\w{8})\w+/, 'sha256 $1…')}<div className="muted">{r.reserve_check}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>How the columns map to controls</h3>
        <table className="table controls">
          <thead>
            <tr><th scope="col">Column</th><th scope="col">Control evidenced (proposed 12 CFR 15.13)</th></tr>
          </thead>
          <tbody>
            {COLUMNS.map((c) => (
              <tr key={c.key}><td>{c.header}</td><td>{c.control}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
