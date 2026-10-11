import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { RunInspectorPage } from '@/components/runs/run-inspector';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('runInspector.meta');
  return { title: t('title') };
}

export default async function RunInspectorRoute({
  params,
}: {
  params: Promise<{ workspaceId: string; runId: string }>;
}) {
  const { workspaceId, runId } = await params;
  return <RunInspectorPage workspaceId={workspaceId} runId={runId} />;
}
