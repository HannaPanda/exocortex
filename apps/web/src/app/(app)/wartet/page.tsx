import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AttentionPage } from '@/components/attention/attention-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('attention.meta');
  return { title: t('title') };
}

export default function AttentionRoute() {
  return <AttentionPage />;
}
