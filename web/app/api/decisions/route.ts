import { demoDecisions } from '@/src/lib/demo';
import type { Decision } from '@/src/lib/model';

export const dynamic = 'force-dynamic';

/** The guardian's decision log, proxied from GUARDIAN_URL; sample decisions (labelled) when it isn't set or is down. */
export async function GET() {
  const base = process.env.GUARDIAN_URL;
  if (base) {
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/decisions`, { signal: AbortSignal.timeout(5000), next: { revalidate: 15 } });
      const body: unknown = await res.json();
      if (res.ok && Array.isArray(body) && body.length) return Response.json({ source: 'live', decisions: body as Decision[] });
    } catch {
      /* fall through to the sample decisions */
    }
  }
  return Response.json({ source: 'demo', decisions: demoDecisions() });
}
