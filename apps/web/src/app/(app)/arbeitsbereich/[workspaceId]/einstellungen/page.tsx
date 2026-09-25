import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { WorkspaceSettings } from '@/components/shell/workspace-settings';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.workspace');
  return { title: t('title') };
}

export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <WorkspaceSettings workspaceId={workspaceId} />;
}
