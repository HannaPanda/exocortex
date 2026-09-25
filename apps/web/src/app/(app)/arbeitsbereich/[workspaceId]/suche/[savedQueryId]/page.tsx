import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SavedQueryPage } from '@/components/search/saved-query-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('search.route');
  return { title: t('savedQueryTitle') };
}

export default async function WorkspaceSavedQueryPage({
  params,
}: {
  params: Promise<{ workspaceId: string; savedQueryId: string }>;
}) {
  const { workspaceId, savedQueryId } = await params;
  return <SavedQueryPage workspaceId={workspaceId} savedQueryId={savedQueryId} />;
}
