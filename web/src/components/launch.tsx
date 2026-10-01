'use client';
import { useState } from 'react';
import { Keypair, Transaction } from '@solana/web3.js';
import { connection, prepare, send } from '@/src/lib/chain';
import { fmtDuration, godKeys } from '@/src/lib/model';
import { launchTx } from '@/src/lib/token';
import { attestIx, pda, setupIxs } from '@/src/lib/vetowall';
import { useConsole } from './console';
import { Addr, PageHead, Panel, TaskStatus, useTask } from './ui';

// Devnet demo delays from docs/SPEC.md, so a queued action matures during a demo.
const DEVNET_DELAYS: [number, number, number, number] = [0, 120, 180, 300];

const STEPS = [
  'Create the mint with every authority set to the Vetowall PDA',
  'Create the Vetowall config and the reserve account',
  'Register the issuer policies: mints, freezes and thaws',
  'Register burns, pause and resume, then seal the config',
  'Attest the opening reserves',
];

export default function Launch() {
  const ctx = useConsole();
  const { snap, keys } = ctx;
  const live = snap.source === 'live';
  const gods = godKeys(snap);
  const task = useTask();
  const [sigs, setSigs] = useState<string[]>([]);
  // A placeholder issuer, so nobody mistakes the form for the live demo token.
  // Cap and reserves start from the live issuer's own figures.
  const [form, setForm] = useState({
    name: 'Acme Dollar',
    symbol: 'ACMEUSD',
    decimals: 6,
    cap: snap.cap?.cap || 5_000_000,
    reserve: snap.reserve?.amount || 10_000_000,
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });

  async function launch() {
    if (!keys) throw new Error('Use demo keys or connect Phantom first.');
    const conn = connection();
    const op = keys.operator.publicKey;
    const config = Keypair.generate();
    const mint = Keypair.generate();
    const authority = pda.authority(config.publicKey);
    const unit = 10n ** BigInt(form.decimals);
    const groups = await setupIxs({
      admin: op,
      config: config.publicKey,
      mint: mint.publicKey,
      proposer: op,
      approver: keys.approver.publicKey,
      guardian: keys.guardian.publicKey,
      attestor: keys.attestor.publicKey,
      delays: DEVNET_DELAYS,
      dailyCap: BigInt(form.cap) * unit,
      maxAge: 86400,
    });
    const attest = await attestIx(config.publicKey, mint.publicKey, keys.attestor.publicKey, BigInt(form.reserve) * unit);
    const txs = [
      await launchTx(conn, op, mint, authority, { name: form.name, symbol: form.symbol, uri: '', decimals: form.decimals }),
      ...groups.map((ixs) => new Transaction().add(...ixs)),
      new Transaction().add(attest),
    ];
    for (const tx of txs) await prepare(tx, op);
    // One wallet prompt for the whole launch; local keys sign after the wallet.
    const signed = await keys.operator.sign(txs);
    signed[0].partialSign(mint);
    signed[1].partialSign(config);
    await keys.attestor.sign([signed[4]]);
    const done: string[] = [];
    for (const tx of signed) {
      done.push(await send(tx));
      setSigs([...done]);
    }
    ctx.setDeployment({ config: config.publicKey.toBase58(), mint: mint.publicKey.toBase58() });
    return `Launched ${form.symbol}. Authorities held by your keys: 0. The console now shows your token.`;
  }

  const blocked = !keys ? 'Use demo keys or connect Phantom (top right) to launch.' : !ctx.programUp ? 'The Vetowall program is not reachable on devnet right now.' : null;

  return (
    <div className="container page">
      <PageHead title="Launch a token with no god keys">
        A Token-2022 mint has up to seven authorities. Each is a key that could mint, freeze, seize or rewrite the token on its own.
        Vetowall assigns every one of them to its program address in the same transaction that creates the mint, so no person ever holds
        one.
      </PageHead>
      <div className="grid-2">
        <Panel
          id="authorities-title"
          title={`${snap.deployment.symbol} authorities`}
          aside={<span className={`mark ${gods ? 'mark-refused' : 'mark-executed'}`}>God keys: {gods}</span>}
        >
          <div className="scroll">
            <table className="table">
              <caption className="sr-only">Who holds each authority on the {snap.deployment.symbol} mint</caption>
              <thead>
                <tr>
                  <th scope="col">Authority</th>
                  <th scope="col">Held by</th>
                </tr>
              </thead>
              <tbody>
                {snap.authorities.map((a) => (
                  <tr key={a.name}>
                    <td>{a.name}</td>
                    <td>
                      {a.holder === snap.deployment.authority ? (
                        <span className="held">
                          <span className="tone-good">Vetowall PDA</span> <Addr value={a.holder} live={live} />
                        </span>
                      ) : a.holder ? (
                        <span className="held">
                          <span className="tone-bad">Outside key</span> <Addr value={a.holder} live={live} />
                        </span>
                      ) : (
                        <span className="muted">None (disabled)</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">
            Mint <Addr value={snap.deployment.mint} live={live} /> · config <Addr value={snap.deployment.config} live={live} /> · PDA seeds{' '}
            <code>[&quot;authority&quot;, config]</code>
          </p>
        </Panel>
        <Panel id="launch-title" title="Launch your own on devnet">
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              task.run(keys?.mode === 'wallet' ? 'Launching: approve the transactions in your wallet' : 'Launching', launch);
            }}
          >
            <label className="field">
              Token name
              <input value={form.name} onChange={set('name')} required maxLength={32} autoComplete="off" />
            </label>
            <div className="row">
              <label className="field">
                Symbol
                <input value={form.symbol} onChange={set('symbol')} required maxLength={10} autoComplete="off" spellCheck={false} />
              </label>
              <label className="field">
                Decimals
                <input type="number" inputMode="numeric" min={0} max={9} value={form.decimals} onChange={set('decimals')} required />
              </label>
            </div>
            <div className="row">
              <label className="field">
                Daily fast-lane cap
                <input type="number" inputMode="decimal" min={1} value={form.cap} onChange={set('cap')} required />
              </label>
              <label className="field">
                Opening reserves
                <input type="number" inputMode="decimal" min={0} value={form.reserve} onChange={set('reserve')} required />
              </label>
            </div>
            <p className="note">
              You are the proposer (maker). The approver (checker), guardian and reserve attestor are demo keys in this browser. Timelocks
              are short for the demo: {DEVNET_DELAYS.map((x) => fmtDuration(x)).join(' / ')} for Safe / Params / Authority / Max.
            </p>
            <div className="actions">
              <button className="btn btn-primary" disabled={!!blocked || !!task.busy} aria-describedby={blocked ? 'launch-blocked' : undefined}>
                Launch {form.symbol || 'token'}
              </button>
            </div>
            {blocked && <p className="note" id="launch-blocked">{blocked}</p>}
          </form>
          <ol className="steps" aria-label="Launch progress">
            {STEPS.map((s, i) => (
              <li key={s} className={sigs[i] ? 'done' : ''}>
                <span>
                  {s}
                  {sigs[i] && <> · <Addr value={sigs[i]} kind="tx" live /></>}
                  {sigs[i] && <span className="sr-only"> (done)</span>}
                </span>
              </li>
            ))}
          </ol>
          <TaskStatus task={task} />
        </Panel>
      </div>
    </div>
  );
}
