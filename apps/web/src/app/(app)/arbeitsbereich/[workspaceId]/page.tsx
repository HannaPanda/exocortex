import type { Metadata } from 'next';

import { WorkspaceOverview } from '@/components/shell/workspace-overview';

export const metadata: Metadata = { title: 'Arbeitsbereich' };

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <WorkspaceOverview workspaceId={workspaceId} />;
}
