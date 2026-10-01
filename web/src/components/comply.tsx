'use client';
import { useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { connection, run } from '@/src/lib/chain';
import { fmtDuration, fmtTime, type Action } from '@/src/lib/model';
import { COLUMNS, reportRows, toCSV, toJSON } from '@/src/lib/report';
import { freezeIx } from '@/src/lib/token';
import { queueIx } from '@/src/lib/vetowall';
import { useConsole } from './console';
import { Mark, PageHead, Panel, SourceBadge, TaskStatus, download, short, useTask } from './ui';

export default function Comply() {
  const ctx = useConsole();
  const { snap, keys, readAt } = ctx;
  const d = snap.deployment;
  const live = snap.source === 'live';
  const canAct = ctx.canAct && keys?.operator.publicKey.toBase58() === d.proposer;
  const task = useTask();
  const [account, setAccount] = useState('');
  const [invalid, setInvalid] = useState(false);
  const rows = reportRows(snap);
  const stamp = fmtTime(readAt).slice(0, 10);
  const count = (s: string) => rows.filter((r) => r.outcome === s).length;

  async function freeze() {
    if (!keys) return;
    let target: PublicKey;
    try {
      target = new PublicKey(account.trim());
    } catch {
      setInvalid(true);
      throw new Error('That is not a valid Solana address. Paste the token account (not the wallet) to freeze.');
    }
    const config = new PublicKey(d.config);
    const ix = await queueIx(
      connection(),
      { config, proposer: keys.operator.publicKey, approver: keys.approver.publicKey },
      freezeIx(target, new PublicKey(d.mint), new PublicKey(d.authority)),
    );
    await run(new Transaction().add(ix), [keys.operator, keys.approver]);
    await ctx.refresh();
    return `Freeze queued. It can run in ${fmtDuration(d.delays[1])}, from the Operate timeline.`;
  }

  return (
    <div className="container page">
      <PageHead title="Comply">
        Every privileged action is an onchain change record. The report below exports them, with each column tied to a control in the OCC&rsquo;s
        proposed rule for payment stablecoin issuers (12 CFR 15.13, risk management and operational standards). Freezes go through the same
        maker-checker and timelock as everything else.
      </PageHead>
      <div className="grid-2">
        <Panel id="export-title" title="Change-control report" aside={<SourceBadge live={live} label={live ? 'Onchain records · devnet' : undefined} />}>
          <dl className="kv">
            <dt>Records</dt><dd>{rows.length}</dd>
            <dt>Executed</dt><dd>{count('executed')}</dd>
            <dt>In timelock</dt><dd>{count('queued')}</dd>
            <dt>Vetoed</dt><dd>{count('vetoed')}</dd>
            <dt>Refused</dt><dd>{count('refused')}</dd>
            <dt>Read at</dt><dd>{fmtTime(readAt)}</dd>
          </dl>
          <div className="actions no-print">
            <button className="btn btn-primary" onClick={() => download(`vetowall-change-control-${stamp}.csv`, 'text/csv', toCSV(rows))}>Download CSV</button>
            <button className="btn" onClick={() => download(`vetowall-change-control-${stamp}.json`, 'application/json', toJSON(snap))}>Download JSON</button>
            <button className="btn" onClick={() => print()}>Print report</button>
          </div>
        </Panel>
        <Panel id="freeze-title" title="Freeze an account via policy">
          <form
            className="form no-print"
            onSubmit={(e) => {
              e.preventDefault();
              task.run('Queueing freeze', freeze);
            }}
          >
            <label className="field">
              Token account to freeze
              <input
                value={account}
                onChange={(e) => {
                  setAccount(e.target.value);
                  setInvalid(false);
                }}
                aria-invalid={invalid || undefined}
                aria-describedby="freeze-help"
                required
                spellCheck={false}
                autoComplete="off"
              />
              <span className="help" id="freeze-help">A Token-2022 account address for this mint.</span>
            </label>
            <p className="note">
              Freeze is a <strong>Params</strong> action: maker and checker both sign, it waits {fmtDuration(d.delays[1])}, and the guardian
              can veto it. Thaw follows the same path.
            </p>
            <div className="actions">
              <button className="btn" disabled={!canAct || !!task.busy}>Queue freeze</button>
            </div>
            {!canAct && <p className="note">Read-only: only this issuer&rsquo;s maker and checker can queue a freeze. Launch your own token to try it.</p>}
          </form>
          <TaskStatus task={task} />
        </Panel>
      </div>
      <section className="panel report" aria-labelledby="report-title">
        <header className="panel-head">
          <h2 id="report-title">Change-control report · {d.symbol}</h2>
          <span className="muted small">
            Read {fmtTime(readAt)}
            {!live && ' · sample data, not onchain'}
          </span>
        </header>
        <p className="print-only">
          Program G8LSBa3y5XqY5fK4R6NTK84oPru3W3hsNzRwjunLWedr · config {d.config} · authority PDA {d.authority} · mint {d.mint} · Solana devnet
        </p>
        <div className="scroll" role="region" aria-labelledby="report-title" tabIndex={0}>
          <table className="table report-table">
            <thead>
              <tr>
                <th scope="col">Change</th>
                <th scope="col">Requested (UTC)</th>
                <th scope="col">Action</th>
                <th scope="col">Class / path</th>
                <th scope="col">Maker / checker</th>
                <th scope="col" className="num">Wait</th>
                <th scope="col">Outcome</th>
                <th scope="col">Guardian / reserves</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.change_id + r.requested_utc}>
                  <td><code>{r.change_id}</code></td>
                  <td>{r.requested_utc.slice(0, 16).replace('T', ' ')}</td>
                  <td>
                    {r.action}
                    {r.amount && <div className="muted">{Number(r.amount.split(' ')[0]).toLocaleString('en-US')} {d.symbol}</div>}
                  </td>
                  <td>{r.risk_class}<div className="muted">{r.path}</div></td>
                  <td>
                    {r.maker ? <code>{short(r.maker)}</code> : '—'}
                    <div className="muted">{!r.checker ? '—' : r.checker.includes(' ') ? r.checker : <code>{short(r.checker)}</code>}</div>
                  </td>
                  <td className="num">{r.waiting_period_hours}h</td>
                  <td><Mark status={r.outcome as Action['status']} /></td>
                  <td className="small">
                    {r.independent_review === 'n/a' ? '' : r.independent_review.replace(/sha256 (\w{8})\w+/, 'sha256 $1…')}
                    {r.reserve_check !== 'n/a' && <div className="muted">{r.reserve_check}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>How the columns map to controls</h3>
        <div className="scroll">
          <table className="table">
            <thead>
              <tr><th scope="col">Column</th><th scope="col">Control evidenced (proposed 12 CFR 15.13)</th></tr>
            </thead>
            <tbody>
              {COLUMNS.map((c) => (
                <tr key={c.key}><td>{c.header}</td><td>{c.control}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
