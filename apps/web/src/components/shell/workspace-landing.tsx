'use client';

import { LayersIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { Button, EmptyState, ErrorState, LoadingState } from '@exocortex/ui';

import { settingsAddress, settingsRequestOf } from '@/components/settings-dialog/sections';
import { useCreateWorkspace, useWorkspaces } from '@/lib/api/workspace-queries';

/** Resolves the workspace to open, or offers to create the first one. */
export function WorkspaceLanding() {
  const t = useTranslations('shell.workspaceLanding');
  const router = useRouter();
  const workspaces = useWorkspaces();
  const createWorkspace = useCreateWorkspace();
  const search = useSearchParams();
  const request = settingsRequestOf(search);
  const carried = request.open ? (request.section ?? '') : null;

  React.useEffect(() => {
    const first = workspaces.data?.[0];
    // The settings dialog rides along (issue #279): the old settings pages
    // send a browser here with `?einstellungen=…`, and it should open over
    // the workspace this lands in rather than be dropped on the way.
    if (first !== undefined) {
      router.replace(
        settingsAddress({ pathname: `/arbeitsbereich/${first.id}`, search: '' }, carried),
      );
    }
  }, [carried, router, workspaces.data]);

  if (workspaces.isPending) return <LoadingState label={t('loading')} />;
  if (workspaces.isError) return <ErrorState onRetry={() => void workspaces.refetch()} />;

  if (workspaces.data.length === 0) {
    return (
      <EmptyState
        className="flex-1"
        icon={LayersIcon}
        title={t('emptyTitle')}
        description={t('emptyDescription')}
      >
        <Button
          variant="outline"
          size="sm"
          data-testid="create-first-workspace"
          disabled={createWorkspace.isPending}
          onClick={() => {
            void createWorkspace
              .mutateAsync(t('defaultName'))
              .then((workspace) => router.replace(`/arbeitsbereich/${workspace.id}`));
          }}
        >
          {t('create')}
        </Button>
      </EmptyState>
    );
  }

  return <LoadingState label={t('opening')} />;
}
