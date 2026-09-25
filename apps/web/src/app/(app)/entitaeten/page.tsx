import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { EntitiesPage } from '@/components/entities/entities-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('entities.metadata');
  return { title: t('title') };
}

export default function EntitiesRoute() {
  return <EntitiesPage />;
}
