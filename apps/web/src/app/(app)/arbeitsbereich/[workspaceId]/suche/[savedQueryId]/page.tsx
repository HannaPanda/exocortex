import type { Metadata } from 'next';

import { SavedQueryPage } from '@/components/search/saved-query-page';

export const metadata: Metadata = { title: 'Gespeicherte Suche' };

export default async function WorkspaceSavedQueryPage({
  params,
}: {
  params: Promise<{ workspaceId: string; savedQueryId: string }>;
}) {
  const { workspaceId, savedQueryId } = await params;
  return <SavedQueryPage workspaceId={workspaceId} savedQueryId={savedQueryId} />;
}
