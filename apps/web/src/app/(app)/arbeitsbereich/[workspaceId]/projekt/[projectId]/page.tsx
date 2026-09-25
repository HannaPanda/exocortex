import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ProjectView } from '@/components/projects/project-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('projects.route');
  return { title: t('title') };
}

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  return <ProjectView workspaceId={workspaceId} projectId={projectId} />;
}
