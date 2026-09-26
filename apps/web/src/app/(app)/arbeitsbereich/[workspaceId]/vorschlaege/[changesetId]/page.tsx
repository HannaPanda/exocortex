import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ChangesetDetailPage } from '@/components/changesets/changeset-detail';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('changesets.route');
  return { title: t('detailTitle') };
}

export default async function WorkspaceChangesetPage({
  params,
}: {
  params: Promise<{ workspaceId: string; changesetId: string }>;
}) {
  const { workspaceId, changesetId } = await params;
  return <ChangesetDetailPage workspaceId={workspaceId} changesetId={changesetId} />;
}
