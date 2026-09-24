'use client';

import { LayersIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button, EmptyState, ErrorState, LoadingState } from '@exocortex/ui';

import { useCreateWorkspace, useWorkspaces } from '@/lib/api/workspace-queries';

/** Resolves the workspace to open, or offers to create the first one. */
export function WorkspaceLanding() {
  const router = useRouter();
  const workspaces = useWorkspaces();
  const createWorkspace = useCreateWorkspace();

  React.useEffect(() => {
    const first = workspaces.data?.[0];
    if (first !== undefined) router.replace(`/arbeitsbereich/${first.id}`);
  }, [router, workspaces.data]);

  if (workspaces.isPending) return <LoadingState label="Arbeitsbereiche werden geladen …" />;
  if (workspaces.isError) return <ErrorState onRetry={() => void workspaces.refetch()} />;

  if (workspaces.data.length === 0) {
    return (
      <EmptyState
        className="flex-1"
        icon={LayersIcon}
        title="Noch kein Arbeitsbereich"
        description="Ein Arbeitsbereich bündelt Seiten, Mitglieder und Dateien."
      >
        <Button
          variant="outline"
          size="sm"
          data-testid="create-first-workspace"
          disabled={createWorkspace.isPending}
          onClick={() => {
            void createWorkspace
              .mutateAsync('Mein Arbeitsbereich')
              .then((workspace) => router.replace(`/arbeitsbereich/${workspace.id}`));
          }}
        >
          Arbeitsbereich anlegen
        </Button>
      </EmptyState>
    );
  }

  return <LoadingState label="Arbeitsbereich wird geöffnet …" />;
}
