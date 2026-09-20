'use client';

import * as React from 'react';

import {
  Alert,
  AlertDescription,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useProvisionEntityDatabase } from '@/lib/api/entity-queries';
import { useWorkspaces } from '@/lib/api/workspace-queries';

/**
 * The one-time setup: a database with the two columns the matcher reads, and
 * `entities.databaseId` pointing at it (issue #47).
 *
 * Administrator-only at the API, and the button says so by failing with the
 * API's own message rather than by being hidden -- the browser does not know
 * the caller's deployment role yet (see `AdminGuard`), and a hidden button
 * would be a worse lie than a refused one.
 *
 * Until this has been done, every entity call answers with `databaseId: null`
 * and an empty list. Before this panel existed there was no way to do it in the
 * browser at all: the route was exempt from the tool catalogue for good reasons
 * and nothing in the UI called it, so a fresh deployment had an entity layer
 * that could only be switched on with a hand-written request.
 */
export function EntityDatabaseSetup() {
  const workspaces = useWorkspaces();
  const provision = useProvisionEntityDatabase();
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);

  const chosen = workspaceId ?? workspaces.data?.[0]?.id ?? null;

  return (
    <Alert className="mt-6">
      <AlertDescription>
        <p>
          Es gibt noch kein Verzeichnis für Entitäten. Es wird als Datenbank in einem Arbeitsbereich
          angelegt; danach sammelt eXocortex Namen aus den Seiten von selbst.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select value={chosen ?? ''} onValueChange={setWorkspaceId}>
            <SelectTrigger className="w-56" data-testid="entity-database-workspace">
              <SelectValue>
                {() =>
                  workspaces.data?.find((workspace) => workspace.id === chosen)?.name ??
                  'Arbeitsbereich wählen'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(workspaces.data ?? []).map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            disabled={chosen === null || provision.isPending}
            data-testid="entity-database-create"
            onClick={() => {
              if (chosen === null) return;
              provision.mutate({ workspaceId: chosen, parentId: null, title: 'Entitäten' });
            }}
          >
            Verzeichnis anlegen
          </Button>
        </div>
        {provision.isError ? (
          <p className="mt-2 text-xs text-destructive-text">{provision.error.message}</p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
