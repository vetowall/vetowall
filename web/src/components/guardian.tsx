'use client';
import { useEffect, useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { connection, run } from '@/src/lib/chain';
import { fmtTime, type Decision } from '@/src/lib/model';
import { pauseIx, resumeIx } from '@/src/lib/token';
import { guardianExecuteIx, queueIx, vetoIx } from '@/src/lib/vetowall';
import { useConsole } from './console';
import { Addr, Icon, Mark, PageHead, Panel, SourceBadge, TaskStatus, sha256, toHex, useTask } from './ui';

const POWERS: [string, boolean][] = [
  ['Veto a queued proposal before it runs', true],
  ['Pause transfers immediately (registered Safe)', true],
  ['Mint, burn or move tokens', false],
  ['Change an authority or a policy', false],
  ['Block its own replacement', false],
];

type Feed = { source: 'live' | 'demo'; decisions: (Decision & { verified: boolean })[] };

async function loadFeed(): Promise<Feed> {
  const { source, decisions } = (await (await fetch('/api/decisions', { cache: 'no-store' })).json()) as { source: Feed['source']; decisions: Decision[] };
  // The onchain veto stores only sha256(explanation); recompute it so anyone can check the text wasn't edited later.
  const verified = await Promise.all(decisions.map(async (d) => toHex(await sha256(d.explanation)) === d.reason_hash));
  return { source, decisions: decisions.map((d, i) => ({ ...d, verified: verified[i] })) };
}

export default function Guardian() {
  const ctx = useConsole();
  const { snap, keys, canAct } = ctx;
  const d = snap.deployment;
  const task = useTask();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [feedError, setFeedError] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const queued = snap.actions.filter((a) => a.status === 'queued' && a.address);
  const vetoed = snap.source === 'live' ? snap.actions.filter((a) => a.status === 'vetoed') : [];
  const isGuardian = keys?.guardian.publicKey.toBase58() === d.guardian;

  useEffect(() => {
    loadFeed().then(setFeed, () => setFeedError(true));
  }, []);

  async function pause() {
    if (!keys) return;
    const ix = await guardianExecuteIx(new PublicKey(d.config), keys.guardian.publicKey, pauseIx(new PublicKey(d.mint), new PublicKey(d.authority)));
    await run(new Transaction().add(ix), [keys.operator, keys.guardian]);
    await ctx.refresh();
    return 'Transfers paused. Resuming is a Params action, so it goes through maker-checker and the timelock.';
  }

  async function queueResume() {
    if (!keys) return;
    const config = new PublicKey(d.config);
    const ix = await queueIx(
      connection(),
      { config, proposer: keys.operator.publicKey, approver: keys.approver.publicKey },
      resumeIx(new PublicKey(d.mint), new PublicKey(d.authority)),
    );
    await run(new Transaction().add(ix), [keys.operator, keys.approver]);
    await ctx.refresh();
    return 'Resume queued by maker and checker. Execute it from the Operate timeline once its timelock ends.';
  }

  async function veto(address: string, id: number | null) {
    if (!keys) return;
    const text = reasons[address]?.trim();
    if (!text) throw new Error(`Write a short reason for vetoing #${id} first. Its SHA-256 is stored onchain with the veto.`);
    if (!confirm(`Veto proposal #${id}? A vetoed proposal can never execute.`)) return;
    const ix = await vetoIx(new PublicKey(d.config), keys.guardian.publicKey, new PublicKey(address), await sha256(text));
    await run(new Transaction().add(ix), [keys.operator, keys.guardian]);
    await ctx.refresh();
    return `Proposal #${id} vetoed.`;
  }

  return (
    <div className="container page">
      <PageHead title="Guardian">
        An independent watcher reads every queued proposal. Fixed rules decide whether to veto; a language model only writes the explanation,
        whose hash goes onchain with the veto. The guardian can stop things. It can&rsquo;t make anything happen except a pause.
      </PageHead>
      <div className="grid-2">
        <Panel id="powers-title" title="What the guardian can do">
          <ul className="powers">
            {POWERS.map(([p, ok]) => (
              <li key={p} className={ok ? 'yes' : 'no'}>
                <Icon name={ok ? 'check' : 'x'} />
                <span>
                  {p}
                  <span className="sr-only">{ok ? ' (allowed)' : ' (not allowed)'}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="note">
            Guardian key <Addr value={d.guardian} live={snap.source === 'live'} />. Enforced by the program, not by policy documents.
          </p>
        </Panel>
        <Panel id="controls-title" title="Guardian controls">
          {canAct && isGuardian ? (
            <>
              <div className="actions">
                <button
                  className="btn btn-danger"
                  disabled={!!task.busy || snap.paused}
                  onClick={() => confirm(`Pause all ${d.symbol} transfers now?`) && task.run('Pausing', pause)}
                >
                  {snap.paused ? 'Transfers paused' : 'Pause transfers now'}
                </button>
                {snap.paused && (
                  <button className="btn" disabled={!!task.busy} onClick={() => task.run('Queueing resume', queueResume)}>
                    Queue resume (maker + checker)
                  </button>
                )}
              </div>
              {queued.length ? (
                <ul className="veto-list">
                  {queued.map((a) => (
                    <li key={a.address}>
                      <strong>
                        #{a.id} {a.action} {a.amount !== undefined && `${a.amount.toLocaleString('en-US')} ${d.symbol}`}
                      </strong>
                      <label className="field">
                        Reason for vetoing #{a.id}
                        <textarea value={reasons[a.address!] ?? ''} onChange={(e) => setReasons({ ...reasons, [a.address!]: e.target.value })} />
                      </label>
                      <div className="actions">
                        <button className="btn btn-danger btn-sm" disabled={!!task.busy} onClick={() => task.run(`Vetoing #${a.id}`, () => veto(a.address!, a.id))}>
                          Veto #{a.id}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="note">Nothing is waiting in the timelock right now.</p>
              )}
            </>
          ) : (
            <p className="note">
              The automated guardian runs as a separate service. With demo keys and a token you launched, this panel lets the demo guardian
              key pause or veto by hand.
            </p>
          )}
          <TaskStatus task={task} />
        </Panel>
      </div>
      {vetoed.length > 0 && (
        <Panel id="onchain-vetoes-title" title={`Vetoes recorded onchain · ${d.symbol}`} aside={<SourceBadge live />}>
          <ol className="decisions">
            {vetoed.map((a) => (
              <li key={a.address}>
                <div className="tl-title">
                  <Mark status="vetoed" />
                  <strong>Proposal #{a.id}: {a.action}</strong>
                  {a.class && <span className="muted small">{a.class} class</span>}
                </div>
                <div className="tl-meta">
                  Queued {fmtTime(a.queuedAt)} · reason hash <code>{a.vetoReason?.slice(0, 12)}…</code> · proposal{' '}
                  <Addr value={a.address!} live />
                  {a.tx && <> · veto tx <Addr value={a.tx} kind="tx" live /></>}
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      )}
      <Panel id="decisions-title" title="Guardian decisions" aside={feed && <SourceBadge live={feed.source === 'live'} label={feed.source === 'live' ? 'Live feed' : 'Sample decisions'} />}>
        {feedError ? (
          <p className="note">The decision feed couldn&rsquo;t be loaded. Reload the page to try again.</p>
        ) : !feed ? (
          <p className="note" aria-busy="true">Loading decisions…</p>
        ) : (
          <ol className="decisions">
            {feed.decisions.map((x) => (
              <li key={`${x.proposal}-${x.ts}`}>
                <div className="tl-title">
                  <Mark status="vetoed" />
                  <strong>Proposal #{x.id}</strong>
                  <code>{x.rule}</code>
                </div>
                <p>{x.explanation}</p>
                <div className="tl-meta">
                  {fmtTime(Date.parse(x.ts) / 1000)} · reason hash <code>{x.reason_hash.slice(0, 12)}…</code>{' '}
                  {x.verified ? (
                    <span className="check tone-good"><Icon name="check" size={12} /> matches the text</span>
                  ) : (
                    <span className="check tone-bad"><Icon name="x" size={12} /> does not match the text</span>
                  )}
                  {' · '}veto tx <Addr value={x.veto_tx} kind="tx" live={feed.source === 'live'} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
