import { useCallback, useEffect, useState } from 'react';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { burner, connection, connectWallet, keypairSigner, type Signer } from './chain';
import { demoSnapshot } from './demo';
import type { Snapshot } from './model';
import { isDeployed, loadSnapshot } from './vetowall';
import { short, useTask } from './ui';
import Launch from './pages/Launch';
import Operate from './pages/Operate';
import Comply from './pages/Comply';
import Guardian from './pages/Guardian';

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
  keys: Keys | null;
  programUp: boolean;
  /** True when this session can send transactions against a live deployment. */
  canAct: boolean;
  refresh(): Promise<void>;
  setDeployment(d: { config: string; mint: string }): void;
}

const PAGES = { launch: Launch, operate: Operate, comply: Comply, guardian: Guardian };
type Page = keyof typeof PAGES;
const LABELS: Record<Page, string> = { launch: 'Launch', operate: 'Operate', comply: 'Comply', guardian: 'Guardian' };

const DEPLOYMENT_KEY = 'vetowall.deployment';
/** The shared devnet demo config; the mint is found from its Reserve account. */
const DEMO_CONFIG: string | undefined = import.meta.env.VITE_CONFIG;

/** A token launched from this browser wins over the shared demo config. */
function savedDeployment(): { config: string; mint?: string } | null {
  try {
    const saved = localStorage.getItem(DEPLOYMENT_KEY);
    if (saved) return JSON.parse(saved);
  } catch {
    /* use env */
  }
  return DEMO_CONFIG ? { config: DEMO_CONFIG } : null;
}

const pageFromHash = (): Page => {
  const h = location.hash.replace(/^#\/?/, '') as Page;
  return h in PAGES ? h : 'launch';
};

const burners = (): Omit<Keys, 'mode' | 'operator'> => ({
  approver: keypairSigner('Approver (demo key)', burner('approver')),
  guardian: keypairSigner('Guardian (demo key)', burner('guardian')),
  attestor: keypairSigner('Attestor (demo key)', burner('attestor')),
});

export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [snap, setSnap] = useState<Snapshot>(demoSnapshot);
  const [programUp, setProgramUp] = useState(false);
  const [keys, setKeys] = useState<Keys | null>(null);
  const [deployment, setDeploymentState] = useState(savedDeployment);
  const [sol, setSol] = useState<number | null>(null);
  const task = useTask();

  useEffect(() => {
    const on = () => setPage(pageFromHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  const refresh = useCallback(async () => {
    const up = await isDeployed();
    setProgramUp(up);
    if (!up || !deployment) return setSnap(demoSnapshot);
    try {
      const live = await loadSnapshot(
        new PublicKey(deployment.config),
        deployment.mint ? new PublicKey(deployment.mint) : undefined,
      );
      setSnap(live ?? demoSnapshot);
    } catch (e) {
      console.warn('Live data unavailable, showing demo data', e);
      setSnap(demoSnapshot);
    }
  }, [deployment]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  const operator = keys?.operator.publicKey.toBase58();
  useEffect(() => {
    if (!operator) return setSol(null);
    connection.getBalance(new PublicKey(operator)).then((l) => setSol(l / LAMPORTS_PER_SOL), () => setSol(null));
  }, [operator, snap]);

  const setDeployment = (d: { config: string; mint: string }) => {
    try {
      localStorage.setItem(DEPLOYMENT_KEY, JSON.stringify(d));
    } catch {
      /* session only */
    }
    setDeploymentState(d);
  };

  const ctx: Ctx = {
    snap,
    keys,
    programUp,
    canAct: !!keys && programUp && snap.source === 'live',
    refresh,
    setDeployment,
  };
  const Current = PAGES[page];
  const demo = snap.source === 'demo';

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <div className="top-inner">
          <a className="brand" href="#/launch" aria-label="Vetowall home">
            <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
              <rect width="32" height="32" rx="7" fill="#1c3d63" />
              <path d="M8 9l8 15 8-15" fill="none" stroke="#34d399" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>Vetowall</span>
            <span className="brand-sub">Issuer console</span>
          </a>
          <nav aria-label="Main">
            {(Object.keys(PAGES) as Page[]).map((p) => (
              <a key={p} href={`#/${p}`} aria-current={p === page ? 'page' : undefined}>
                {LABELS[p]}
              </a>
            ))}
          </nav>
          <div className="session">
            <span className={`badge ${demo ? 'badge-demo' : 'badge-live'}`}>{demo ? 'Demo data' : 'Live · devnet'}</span>
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
                    task.run('Requesting devnet SOL', async () => {
                      await connection.requestAirdrop(keys.operator.publicKey, LAMPORTS_PER_SOL).then((s) => connection.confirmTransaction(s));
                      setSol((await connection.getBalance(keys.operator.publicKey)) / LAMPORTS_PER_SOL);
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
                  onClick={() =>
                    task.run('Connecting', async () => {
                      setKeys({ mode: 'wallet', operator: await connectWallet(), ...burners() });
                    })
                  }
                >
                  Connect Phantom
                </button>
                <button
                  className="btn btn-quiet"
                  title="Burner keypairs stored in this browser. Devnet only."
                  onClick={() => setKeys({ mode: 'demo', operator: keypairSigner('Proposer (demo key)', burner('proposer')), ...burners() })}
                >
                  Use demo keys
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      {(task.error || (task.busy && !keys)) && (
        <div className="banner banner-error" role="alert">{task.error ?? `${task.busy}…`}</div>
      )}
      {demo && (
        <div className="banner">
          <strong>Demo data.</strong> You're looking at a sample issuer, USDV, with seeded history.{' '}
          {!programUp
            ? 'The Vetowall program is not reachable on devnet yet, so actions are turned off.'
            : keys
              ? 'Launch a token on the Launch page to switch to live data.'
              : 'Connect Phantom or use demo keys, then launch a token to switch to live data.'}
        </div>
      )}
      {keys?.mode === 'demo' && (
        <div className="banner banner-warn">
          Demo keys are burner keypairs kept in this browser's storage. Devnet only: never send them real funds.
        </div>
      )}
      <main id="main" className="wrap">
        <Current ctx={ctx} />
      </main>
      <footer className="foot wrap">
        Vetowall · program <code>G8LS…LWedr</code> · Solana devnet · Every action here maps to an onchain account you can verify on Solana Explorer.
      </footer>
    </>
  );
}
