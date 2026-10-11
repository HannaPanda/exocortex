import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { WorkflowEditor } from '@/components/workflows/workflow-editor';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('workflows.route');
  return { title: t('editorTitle') };
}

export default async function WorkspaceWorkflowPage({
  params,
}: {
  params: Promise<{ workspaceId: string; workflowId: string }>;
}) {
  const { workspaceId, workflowId } = await params;
  return <WorkflowEditor workspaceId={workspaceId} workflowId={workflowId} />;
}
