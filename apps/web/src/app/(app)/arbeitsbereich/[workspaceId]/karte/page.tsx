import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { KnowledgeMapScreen } from '@/components/knowledge-map/knowledge-map-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('knowledgeMap.route');
  return { title: t('title') };
}

export default async function WorkspaceKnowledgeMapPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <KnowledgeMapScreen workspaceId={workspaceId} />;
}
