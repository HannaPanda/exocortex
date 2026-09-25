import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SavedQueryPage } from '@/components/search/saved-query-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('search.route');
  return { title: t('searchTitle') };
}

export default async function WorkspaceSearchPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <SavedQueryPage workspaceId={workspaceId} />;
}
