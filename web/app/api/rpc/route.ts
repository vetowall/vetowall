import { handleRpc } from '@/src/lib/rpc-proxy';

// SOLANA_RPC_URL is server-only (no NEXT_PUBLIC_ prefix), so the key never reaches the browser.
export async function POST(req: Request) {
  return handleRpc(req, { upstream: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com' });
}
