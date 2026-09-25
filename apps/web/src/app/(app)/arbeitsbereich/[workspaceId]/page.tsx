import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { WorkspaceOverview } from '@/components/shell/workspace-overview';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('document.metadata');
  return { title: t('workspace') };
}

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <WorkspaceOverview workspaceId={workspaceId} />;
}
