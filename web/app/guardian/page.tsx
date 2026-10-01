import type { Metadata } from 'next';
import Guardian from '@/src/components/guardian';

export const metadata: Metadata = { title: 'Guardian' };

export default function Page() {
  return <Guardian />;
}
