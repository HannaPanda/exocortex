'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { ErrorState, LoadingState } from '@exocortex/ui';

import { useAiRun } from '@/lib/api/ai-queries';

import { runInspectorHref } from './run-links';

/** Sends a run's short address on to its workspace, once the run says which one that is. */
export function RunInspectorRedirect({ runId }: { runId: string }) {
  const t = useTranslations('runInspector.page');
  const router = useRouter();
  const query = useAiRun(runId);
  const workspaceId = query.data?.workspaceId ?? null;

  React.useEffect(() => {
    if (workspaceId !== null) router.replace(runInspectorHref(workspaceId, runId));
  }, [router, workspaceId, runId]);

  if (query.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void query.refetch()} />;
  }
  return <LoadingState variant="skeleton" rows={8} label={t('loading')} />;
}
