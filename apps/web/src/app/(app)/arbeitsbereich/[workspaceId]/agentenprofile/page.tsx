import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AgentProfilesPage } from '@/components/agent-profiles/agent-profiles-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('agentProfiles.route');
  return { title: t('listTitle') };
}

export default async function WorkspaceAgentProfilesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <AgentProfilesPage workspaceId={workspaceId} />;
}
