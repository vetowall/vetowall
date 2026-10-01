import type { Metadata } from 'next';
import Comply from '@/src/components/comply';

export const metadata: Metadata = { title: 'Comply' };

export default function Page() {
  return <Comply />;
}
