import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { WorkItemDetailPage } from '@/components/work-items/work-item-detail';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('workItems.route');
  return { title: t('detailTitle') };
}

export default async function WorkspaceWorkItemPage({
  params,
}: {
  params: Promise<{ workspaceId: string; workItemId: string }>;
}) {
  const { workspaceId, workItemId } = await params;
  return <WorkItemDetailPage workspaceId={workspaceId} workItemId={workItemId} />;
}
