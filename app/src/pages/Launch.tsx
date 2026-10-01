import { useState } from 'react';
import { Keypair, Transaction } from '@solana/web3.js';
import type { Ctx } from '../App';
import { connection, prepare, send } from '../chain';
import { fmtDuration, godKeys } from '../model';
import { launchTx } from '../token';
import { Addr, Card, TaskStatus, useTask } from '../ui';
import { attestIx, pda, setupIxs } from '../vetowall';

// Devnet demo delays from docs/SPEC.md, so a queued action matures during a demo.
const DEVNET_DELAYS: [number, number, number, number] = [0, 120, 180, 300];

const STEPS = [
  'Create the mint with every authority set to the Vetowall PDA',
  'Create the Vetowall config and the reserve account',
  'Register the issuer policies: mints, freezes and thaws',
  'Register burns, pause and resume, then seal the config',
  'Attest the opening reserves',
];

export default function Launch({ ctx }: { ctx: Ctx }) {
  const { snap, keys } = ctx;
  const live = snap.source === 'live';
  const gods = godKeys(snap);
  const task = useTask();
  const [sigs, setSigs] = useState<string[]>([]);
  const [form, setForm] = useState({ name: 'Vetowall Demo Dollar', symbol: 'USDV', decimals: 6, cap: 10_000_000, reserve: 25_000_000 });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });

  async function launch() {
    if (!keys) throw new Error('Connect a wallet or use demo keys first.');
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
      await launchTx(connection, op, mint, authority, { name: form.name, symbol: form.symbol, uri: '', decimals: form.decimals }),
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
    return `Launched ${form.symbol}. Authorities held by your keys: 0.`;
  }

  return (
    <>
      <div className="page-head">
        <h1>Launch a token with no god keys</h1>
        <p className="lede">
          A Token-2022 mint has up to seven authorities. Each is a key that could mint, freeze, seize or rewrite the token on its own.
          Vetowall assigns every one of them to its program address in the same transaction that creates the mint, so no person ever
          holds one.
        </p>
      </div>
      <div className="grid-2">
        <Card title={`${snap.deployment.symbol} authorities`} aside={<span className={`godkeys ${gods ? 'bad' : ''}`}>God keys: {gods}</span>}>
          <table className="table">
            <thead>
              <tr><th scope="col">Authority</th><th scope="col">Held by</th></tr>
            </thead>
            <tbody>
              {snap.authorities.map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td>
                    {a.holder === snap.deployment.authority ? (
                      <span className="held">Vetowall PDA <Addr value={a.holder} live={live} /></span>
                    ) : a.holder ? (
                      <span className="held bad">Outside key <Addr value={a.holder} live={live} /></span>
                    ) : (
                      <span className="muted">None (disabled)</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">
            Mint <Addr value={snap.deployment.mint} live={live} /> · Config <Addr value={snap.deployment.config} live={live} /> · PDA
            seeds <code>["authority", config]</code>
          </p>
        </Card>
        <Card title="Launch on devnet">
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              task.run('Launching: approve the transactions in your wallet', launch);
            }}
          >
            <label>Token name<input value={form.name} onChange={set('name')} required maxLength={32} /></label>
            <div className="row">
              <label>Symbol<input value={form.symbol} onChange={set('symbol')} required maxLength={10} /></label>
              <label>Decimals<input type="number" min={0} max={9} value={form.decimals} onChange={set('decimals')} required /></label>
            </div>
            <div className="row">
              <label>Daily fast-lane cap<input type="number" min={1} value={form.cap} onChange={set('cap')} required /></label>
              <label>Opening reserves<input type="number" min={0} value={form.reserve} onChange={set('reserve')} required /></label>
            </div>
            <p className="note">
              Roles: you are the proposer (maker). The approver (checker), guardian and reserve attestor are demo keys in this browser.
              Timelocks are short for the demo: {DEVNET_DELAYS.map((d) => fmtDuration(d)).join(' / ')} for Safe / Params / Authority / Max.
            </p>
            <button className="btn btn-primary" disabled={!keys || !ctx.programUp || !!task.busy}>
              Launch {form.symbol}
            </button>
            {!keys && <p className="note">Connect Phantom or use demo keys to launch.</p>}
            {keys && !ctx.programUp && <p className="note">The program isn't deployed on devnet yet.</p>}
          </form>
          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={s} className={sigs[i] ? 'done' : ''}>
                {s}
                {sigs[i] && <> · <Addr value={sigs[i]} kind="tx" live /></>}
              </li>
            ))}
          </ol>
          <TaskStatus task={task} />
        </Card>
      </div>
    </>
  );
}
