import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { HelpPage } from '@/components/help/help-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('help.metadata');
  return { title: t('title') };
}

export default function HelpRoute() {
  return <HelpPage />;
}
