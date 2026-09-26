import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { WorkItemsPage } from '@/components/work-items/work-items-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('workItems.route');
  return { title: t('listTitle') };
}

export default async function WorkspaceWorkItemsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <WorkItemsPage workspaceId={workspaceId} />;
}
