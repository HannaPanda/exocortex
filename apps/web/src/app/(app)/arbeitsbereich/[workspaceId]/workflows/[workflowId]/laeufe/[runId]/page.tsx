import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { WorkflowRunDetail } from '@/components/workflows/workflow-run-detail';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('workflows.route');
  return { title: t('runTitle') };
}

export default async function WorkspaceWorkflowRunPage({
  params,
}: {
  params: Promise<{ workspaceId: string; workflowId: string; runId: string }>;
}) {
  const { workspaceId, workflowId, runId } = await params;
  return <WorkflowRunDetail workspaceId={workspaceId} workflowId={workflowId} runId={runId} />;
}
