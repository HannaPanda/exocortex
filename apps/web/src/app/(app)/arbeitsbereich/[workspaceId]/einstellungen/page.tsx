import { redirect } from 'next/navigation';

import { WORKSPACE_TAB_PARAM } from '@/components/palette/settings-addresses';
import { workspaceSettingsRedirect } from '@/components/settings-dialog/sections';

/**
 * The workspace settings became groups of the settings dialog (issue #279).
 * This address stays for every bookmark and link that knows it, and opens the
 * dialog over the workspace's start page at the group its `?tab=` became.
 */
export default async function WorkspaceSettingsRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const tab = (await searchParams)[WORKSPACE_TAB_PARAM];
  redirect(workspaceSettingsRedirect(workspaceId, typeof tab === 'string' ? tab : null));
}
