import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ChangesetsPage } from '@/components/changesets/changesets-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('changesets.route');
  return { title: t('listTitle') };
}

export default async function WorkspaceChangesetsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <ChangesetsPage workspaceId={workspaceId} />;
}
