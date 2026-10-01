import { useEffect, useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import type { Ctx } from '../App';
import { run } from '../chain';
import { demoDecisions } from '../demo';
import { fmtTime, type Decision } from '../model';
import { pauseIx } from '../token';
import { Addr, Card, TaskStatus, sha256, toHex, useTask } from '../ui';
import { guardianExecuteIx, vetoIx } from '../vetowall';

const GUARDIAN_URL = import.meta.env.VITE_GUARDIAN_URL as string | undefined;

const POWERS: [string, boolean][] = [
  ['Veto a queued proposal before it runs', true],
  ['Pause transfers immediately (registered Safe)', true],
  ['Mint, burn or move tokens', false],
  ['Change an authority or a policy', false],
  ['Block its own replacement', false],
];

type Feed = { source: 'live' | 'demo'; decisions: (Decision & { verified: boolean })[] };

async function loadFeed(): Promise<Feed> {
  let source: Feed['source'] = 'demo';
  let decisions = demoDecisions;
  if (GUARDIAN_URL) {
    try {
      const res = await fetch(`${GUARDIAN_URL.replace(/\/$/, '')}/decisions`, { signal: AbortSignal.timeout(5000) });
      const body = await res.json();
      if (res.ok && Array.isArray(body) && body.length) [source, decisions] = ['live', body];
    } catch {
      /* fall back to the seeded examples */
    }
  }
  // The onchain veto stores only sha256(explanation); recompute it so anyone can check the text wasn't edited later.
  const verified = await Promise.all(decisions.map(async (d) => toHex(await sha256(d.explanation)) === d.reason_hash));
  return { source, decisions: decisions.map((d, i) => ({ ...d, verified: verified[i] })) };
}

export default function Guardian({ ctx }: { ctx: Ctx }) {
  const { snap, keys, canAct } = ctx;
  const d = snap.deployment;
  const task = useTask();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const queued = snap.actions.filter((a) => a.status === 'queued' && a.address);
  const isGuardian = keys?.guardian.publicKey.toBase58() === d.guardian;

  useEffect(() => {
    loadFeed().then(setFeed);
  }, []);

  async function pause() {
    if (!keys) return;
    const ix = await guardianExecuteIx(new PublicKey(d.config), keys.guardian.publicKey, pauseIx(new PublicKey(d.mint), new PublicKey(d.authority)));
    await run(new Transaction().add(ix), [keys.operator, keys.guardian]);
    await ctx.refresh();
    return 'Transfers paused. Resuming is a Params action, so it goes through maker-checker and the timelock.';
  }

  async function veto(address: string, id: number | null) {
    if (!keys) return;
    const text = reasons[address]?.trim();
    if (!text) throw new Error('Write a short reason first. Its SHA-256 is stored onchain.');
    const ix = await vetoIx(new PublicKey(d.config), keys.guardian.publicKey, new PublicKey(address), await sha256(text));
    await run(new Transaction().add(ix), [keys.operator, keys.guardian]);
    await ctx.refresh();
    return `Proposal #${id} vetoed.`;
  }

  return (
    <>
      <div className="page-head">
        <h1>Guardian</h1>
        <p className="lede">
          An independent watcher reads every queued proposal. Fixed rules decide whether to veto; a language model only writes the
          explanation, whose hash goes onchain with the veto. The guardian can stop things. It can't make anything happen except a pause.
        </p>
      </div>
      <div className="grid-2">
        <Card title="What the guardian can do">
          <ul className="powers">
            {POWERS.map(([p, ok]) => (
              <li key={p} className={ok ? 'yes' : 'no'}>
                <span aria-hidden="true">{ok ? '✓' : '✕'}</span> {p}
                <span className="sr-only">{ok ? ' (allowed)' : ' (not allowed)'}</span>
              </li>
            ))}
          </ul>
          <p className="note">
            Guardian key <Addr value={d.guardian} live={snap.source === 'live'} />. Enforced by the program, not by policy documents.
          </p>
        </Card>
        <Card title="Guardian controls">
          {canAct && isGuardian ? (
            <>
              <button className="btn btn-danger" disabled={!!task.busy || snap.paused} onClick={() => task.run('Pausing', pause)}>
                {snap.paused ? 'Transfers paused' : 'Pause transfers now'}
              </button>
              {queued.length ? (
                <ul className="veto-list">
                  {queued.map((a) => (
                    <li key={a.address}>
                      <strong>#{a.id} {a.action}</strong> {a.amount !== undefined && `${a.amount.toLocaleString('en-US')} ${d.symbol}`}
                      <textarea
                        aria-label={`Reason for vetoing proposal ${a.id}`}
                        placeholder="Why is this being vetoed?"
                        value={reasons[a.address!] ?? ''}
                        onChange={(e) => setReasons({ ...reasons, [a.address!]: e.target.value })}
                      />
                      <button className="btn btn-danger btn-sm" disabled={!!task.busy} onClick={() => task.run(`Vetoing #${a.id}`, () => veto(a.address!, a.id))}>
                        Veto #{a.id}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="note">Nothing is waiting in the timelock right now.</p>
              )}
            </>
          ) : (
            <p className="note">
              The automated guardian runs as a separate service. With demo keys and a launched token, this panel lets the demo guardian key
              pause or veto by hand.
            </p>
          )}
          <TaskStatus task={task} />
        </Card>
      </div>
      <Card
        title="Guardian decisions"
        aside={feed && <span className={`badge ${feed.source === 'demo' ? 'badge-demo' : 'badge-live'}`}>{feed.source === 'demo' ? 'Demo data' : 'Live feed'}</span>}
      >
        {!feed ? (
          <p className="note">Loading…</p>
        ) : (
          <ol className="decisions">
            {feed.decisions.map((x) => (
              <li key={`${x.proposal}-${x.ts}`}>
                <div className="tl-title">
                  <span className="pill pill-vetoed">vetoed</span>
                  <strong>Proposal #{x.id}</strong>
                  <code className="rule">{x.rule}</code>
                </div>
                <p>{x.explanation}</p>
                <div className="tl-meta">
                  {fmtTime(Date.parse(x.ts) / 1000)} · reason hash <code>{x.reason_hash.slice(0, 12)}…</code>{' '}
                  {x.verified ? <span className="ok-inline">matches the text</span> : <span className="bad-inline">does not match the text</span>}
                  {' · '}veto tx <Addr value={x.veto_tx} kind="tx" live={feed.source === 'live'} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
