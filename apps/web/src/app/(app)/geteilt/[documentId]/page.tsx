import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SharedDocumentPage } from '@/components/shell/shared-document-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shares.meta');
  return { title: t('sharedPageTitle') };
}

export default async function SharedDocumentRoute({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = await params;
  return <SharedDocumentPage documentId={documentId} />;
}
