import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AgentProfileDetail } from '@/components/agent-profiles/agent-profile-detail';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('agentProfiles.route');
  return { title: t('detailTitle') };
}

export default async function WorkspaceAgentProfilePage({
  params,
}: {
  params: Promise<{ workspaceId: string; profileId: string }>;
}) {
  const { workspaceId, profileId } = await params;
  return <AgentProfileDetail workspaceId={workspaceId} profileId={profileId} />;
}
