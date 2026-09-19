import type { Metadata } from 'next';

import { WorkspaceSharesPage } from '@/components/shell/workspace-shares-page';

export const metadata: Metadata = { title: 'Freigaben' };

export default async function WorkspaceSharesRoute({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <WorkspaceSharesPage workspaceId={workspaceId} />;
}
