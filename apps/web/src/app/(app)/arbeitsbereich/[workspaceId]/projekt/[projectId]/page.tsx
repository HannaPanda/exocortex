import type { Metadata } from 'next';

import { ProjectView } from '@/components/projects/project-view';

export const metadata: Metadata = { title: 'Projekt' };

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  return <ProjectView workspaceId={workspaceId} projectId={projectId} />;
}
