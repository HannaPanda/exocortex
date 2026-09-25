import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { WORKSPACE_TAB_PARAM } from '@/components/palette/settings-addresses';
import { WorkspaceSettings } from '@/components/shell/workspace-settings';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.workspace');
  return { title: t('title') };
}

/** `?tab=mitglieder` opens that tab, where a palette command lands (issue #148). */
export default async function WorkspaceSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const requested = (await searchParams)[WORKSPACE_TAB_PARAM];
  return (
    <WorkspaceSettings
      workspaceId={workspaceId}
      requestedTab={typeof requested === 'string' ? requested : null}
    />
  );
}
