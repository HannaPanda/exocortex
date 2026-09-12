import type { Metadata } from 'next';

import { AutomationsPage } from '@/components/automations/automations-page';

export const metadata: Metadata = { title: 'Automationen' };

export default async function WorkspaceAutomationsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <AutomationsPage workspaceId={workspaceId} />;
}
