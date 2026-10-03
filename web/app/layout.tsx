import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans, Source_Serif_4 } from 'next/font/google';
import { ConsoleProvider } from '@/src/components/console';
import { getSnapshot } from '@/src/lib/snapshot';
import './globals.css';

// Rendered per request from the ~15s shared snapshot cache.
export const dynamic = 'force-dynamic';

const plex = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-plex', display: 'swap' });
const serif = Source_Serif_4({ subsets: ['latin'], weight: ['600'], variable: '--font-source-serif', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Vetowall: the control plane for stablecoin issuers on Solana', template: '%s · Vetowall' },
  description:
    'Vetowall holds a Token-2022 issuer’s authorities in a Solana program: maker-checker mints bounded by attested reserves, timelocks, a guardian veto and onchain change-control records.',
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23202838'/%3E%3Cpath d='M9 10l7 13 7-13' fill='none' stroke='%23fff' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E",
  },
};

/** Reads the saved theme and accepts only the two values we write; anything else leaves the OS preference in charge. */
const THEME_BOOT = `try{var t=localStorage.getItem('vetowall.theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}`;

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const initial = await getSnapshot();
  return (
    // The script below may set data-theme before React hydrates, so the attribute can differ from the server's HTML.
    <html lang="en" className={`${plex.variable} ${serif.variable}`} suppressHydrationWarning>
      <head>
        {/* Applies a saved theme before first paint; see ThemeSwitch. A static string, so nothing user-controlled is injected. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <ConsoleProvider initial={initial} serverNow={Math.floor(Date.now() / 1000)}>
          {children}
        </ConsoleProvider>
      </body>
    </html>
  );
}
