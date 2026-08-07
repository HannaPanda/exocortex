import type { Metadata } from 'next';

import { WorkspaceSettings } from '@/components/shell/workspace-settings';

export const metadata: Metadata = { title: 'Arbeitsbereich-Einstellungen' };

export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <WorkspaceSettings workspaceId={workspaceId} />;
}
