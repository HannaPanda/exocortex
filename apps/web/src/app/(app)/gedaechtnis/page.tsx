import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { MemoryFactsPage } from '@/components/memory/memory-facts-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('memory.metadata');
  return { title: t('title') };
}

export default function MemoryFactsRoute() {
  return <MemoryFactsPage />;
}
