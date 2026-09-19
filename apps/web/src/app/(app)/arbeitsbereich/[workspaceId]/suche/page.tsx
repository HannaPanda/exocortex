import type { Metadata } from 'next';

import { SavedQueryPage } from '@/components/search/saved-query-page';

export const metadata: Metadata = { title: 'Suche' };

export default async function WorkspaceSearchPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <SavedQueryPage workspaceId={workspaceId} />;
}
