import type { Metadata } from 'next';
import Launch from '@/src/components/launch';

export const metadata: Metadata = { title: 'Launch' };

export default function Page() {
  return <Launch />;
}
