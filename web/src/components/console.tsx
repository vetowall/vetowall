'use client';
// Session state shared by every page: the snapshot (server-rendered, then
// refreshed from /api/snapshot), the signing keys, and the header.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { airdrop, burner, connection, connectWallet, keypairSigner, type Signer } from '@/src/lib/chain';
import type { Payload } from '@/src/lib/snapshot';
import type { Snapshot } from '@/src/lib/model';
import { SourceBadge, ThemeSwitch, short, useTask } from './ui';

export interface Keys {
  mode: 'wallet' | 'demo';
  /** Pays fees; also the admin and proposer (maker). */
  operator: Signer;
  approver: Signer;
  guardian: Signer;
  attestor: Signer;
}

export interface Ctx {
  snap: Snapshot;
  /** Server time of the snapshot read, unix seconds. */
  readAt: number;
  keys: Keys | null;
  programUp: boolean;
  /** True when this session can send transactions against a live deployment. */
  canAct: boolean;
  refresh(): Promise<void>;
  setDeployment(d: { config: string; mint: string } | null): void;
}

const Context = createContext<Ctx | null>(null);
const NowContext = createContext(0);

export function useConsole() {
  const c = useContext(Context);
  if (!c) throw new Error('useConsole outside ConsoleProvider');
  return c;
}

/** Ticking clock, seeded with the server's render time so the first client render matches the HTML. */
export const useNow = () => useContext(NowContext);

const DEPLOYMENT_KEY = 'vetowall.deployment';
const REFRESH_MS = 20_000;

const burners = (): Omit<Keys, 'mode' | 'operator'> => ({
  approver: keypairSigner('Approver (demo key)', burner('approver')),
  guardian: keypairSigner('Guardian (demo key)', burner('guardian')),
  attestor: keypairSigner('Attestor (demo key)', burner('attestor')),
});

const NAV = [
  ['/', 'Overview'],
  ['/operate', 'Operate'],
  ['/comply', 'Comply'],
  ['/guardian', 'Guardian'],
  ['/launch', 'Launch'],
] as const;

export function ConsoleProvider({ initial, serverNow, children }: { initial: Payload; serverNow: number; children: ReactNode }) {
  const [payload, setPayload] = useState(initial);
  const [now, setNow] = useState(serverNow);
  const [keys, setKeys] = useState<Keys | null>(null);
  const [deployment, setDeploymentState] = useState<{ config: string; mint?: string } | null>(null);
  const [sol, setSol] = useState<number | null>(null);
  const task = useTask();
  const pathname = usePathname();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);

  // A token launched from this browser wins over the shared demo issuer.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(DEPLOYMENT_KEY);
      if (saved) setDeploymentState(JSON.parse(saved));
    } catch {
      /* storage blocked: stay on the shared issuer */
    }
  }, []);

  const refresh = useCallback(async () => {
    const q = deployment ? `?${new URLSearchParams({ config: deployment.config, ...(deployment.mint && { mint: deployment.mint }) })}` : '';
    try {
      const res = await fetch(`/api/snapshot${q}`, { cache: 'no-store' });
      if (res.ok) setPayload(await res.json());
    } catch {
      /* offline: keep showing the last snapshot */
    }
  }, [deployment]);

  useEffect(() => {
    if (deployment) refresh();
    const t = setInterval(() => document.visibilityState === 'visible' && refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [deployment, refresh]);

  const operator = keys?.operator.publicKey.toBase58();
  useEffect(() => {
    if (!operator) return;
    let stale = false;
    connection()
      .getBalance(new PublicKey(operator))
      .then((l) => !stale && setSol(l / LAMPORTS_PER_SOL), () => !stale && setSol(null));
    return () => {
      stale = true;
    };
  }, [operator, payload]);

  const setDeployment = (d: { config: string; mint: string } | null) => {
    try {
      if (d) localStorage.setItem(DEPLOYMENT_KEY, JSON.stringify(d));
      else localStorage.removeItem(DEPLOYMENT_KEY);
    } catch {
      /* session only */
    }
    setDeploymentState(d);
    // Back on the shared issuer: show the server's snapshot until the next refresh.
    if (!d) setPayload(initial);
  };

  const { snap, programUp, at } = payload;
  const live = snap.source === 'live';
  const ctx: Ctx = { snap, readAt: at, keys, programUp, canAct: !!keys && programUp && live, refresh, setDeployment };

  return (
    <Context.Provider value={ctx}>
      <NowContext.Provider value={now}>
        <a className="skip" href="#main">Skip to content</a>
        <header className="top">
          <div className="container top-inner">
            <Link className="brand" href="/">
              <svg className="brand-mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
                <rect width="32" height="32" rx="6" />
                <path d="M9 10l7 13 7-13" fill="none" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Vetowall
            </Link>
            <nav className="nav" aria-label="Main">
              {NAV.map(([href, label]) => (
                <Link key={href} href={href} aria-current={pathname === href ? 'page' : undefined}>
                  {label}
                </Link>
              ))}
            </nav>
            <span className="top-source">
              <SourceBadge live={live} />
              <ThemeSwitch />
            </span>
            <div className="session">
              {keys ? (
                <>
                  <span className="who" title={operator}>
                    {keys.mode === 'demo' ? 'Demo keys' : keys.operator.label} · {short(operator!)}
                    {sol !== null && ` · ${sol.toFixed(2)} SOL`}
                  </span>
                  <button
                    className="btn btn-quiet"
                    disabled={!!task.busy}
                    onClick={() =>
                      task.run('Requesting 1 devnet SOL', async () => {
                        await airdrop(keys.operator.publicKey);
                        setSol((await connection().getBalance(keys.operator.publicKey)) / LAMPORTS_PER_SOL);
                      })
                    }
                  >
                    Airdrop 1 SOL
                  </button>
                  <button className="btn btn-quiet" onClick={() => setKeys(null)}>Disconnect</button>
                </>
              ) : (
                <>
                  <button
                    className="btn"
                    title="Burner keypairs stored in this browser. Devnet only."
                    onClick={() => setKeys({ mode: 'demo', operator: keypairSigner('Proposer (demo key)', burner('proposer')), ...burners() })}
                  >
                    Use demo keys
                  </button>
                  <button
                    className="btn"
                    disabled={!!task.busy}
                    onClick={() => task.run('Connecting', async () => setKeys({ mode: 'wallet', operator: await connectWallet(), ...burners() }))}
                  >
                    Connect Phantom
                  </button>
                </>
              )}
            </div>
          </div>
        </header>
        <div role="status" aria-live="polite">
          {(task.error || task.busy) && (
            <div className={`banner ${task.error ? 'banner-error' : ''}`}>
              <div className="container">{task.error ?? `${task.busy}…`}</div>
            </div>
          )}
        </div>
        {!live && (
          <div className="banner banner-warn">
            <div className="container">
              <strong>Sample data.</strong> The live devnet issuer couldn&rsquo;t be read just now, so you&rsquo;re looking at a fictional
              issuer, Sample Dollar (SAMPLE). None of it is onchain. The console retries every {REFRESH_MS / 1000} seconds.
              {!programUp && ' The Vetowall program is not reachable, so actions are turned off.'}
            </div>
          </div>
        )}
        {deployment && (
          <div className="banner">
            <div className="container actions">
              <span>You&rsquo;re viewing {snap.deployment.symbol}, the token you launched from this browser.</span>
              <button className="btn btn-sm" onClick={() => setDeployment(null)}>Back to the shared demo issuer</button>
            </div>
          </div>
        )}
        {keys?.mode === 'demo' && (
          <div className="banner">
            <div className="container">
              Demo keys are burner keypairs kept in this browser&rsquo;s storage. Devnet only: never send them real funds.
            </div>
          </div>
        )}
        <main id="main" tabIndex={-1}>{children}</main>
        <footer className="foot">
          <div className="container">
            <span>
              Vetowall program{' '}
              <a className="addr" href="https://explorer.solana.com/address/G8LSBa3y5XqY5fK4R6NTK84oPru3W3hsNzRwjunLWedr?cluster=devnet" target="_blank" rel="noreferrer">
                G8LS…LWedr
              </a>{' '}
              on Solana devnet
            </span>
            <span>Every figure maps to an account or transaction you can verify on Solana Explorer.</span>
            <a href="https://github.com/vetowall/vetowall" target="_blank" rel="noreferrer">Source on GitHub</a>
          </div>
        </footer>
      </NowContext.Provider>
    </Context.Provider>
  );
}
