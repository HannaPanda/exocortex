import type { Metadata } from 'next';

import { MemoryFactsPage } from '@/components/memory/memory-facts-page';

export const metadata: Metadata = { title: 'Gedächtnis' };

export default function MemoryFactsRoute() {
  return <MemoryFactsPage />;
}
