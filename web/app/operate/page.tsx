import type { Metadata } from 'next';
import Operate from '@/src/components/operate';

export const metadata: Metadata = { title: 'Operate' };

export default function Page() {
  return <Operate />;
}
