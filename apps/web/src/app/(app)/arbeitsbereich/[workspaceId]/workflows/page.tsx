import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { WorkflowsPage } from '@/components/workflows/workflows-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('workflows.route');
  return { title: t('listTitle') };
}

export default async function WorkspaceWorkflowsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <WorkflowsPage workspaceId={workspaceId} />;
}
