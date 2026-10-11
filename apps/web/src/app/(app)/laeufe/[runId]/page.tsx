import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { RunInspectorRedirect } from '@/components/runs/run-inspector-redirect';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('runInspector.meta');
  return { title: t('title') };
}

/**
 * The short address of a run (issue #145): a chat answer knows its run but
 * not its workspace, so it links here and is sent on to the run's workspace,
 * where the shell shows the right tree and chat.
 */
export default async function RunInspectorShortRoute({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <RunInspectorRedirect runId={runId} />;
}
