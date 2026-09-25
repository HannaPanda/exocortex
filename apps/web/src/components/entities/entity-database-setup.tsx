'use client';

import { useTranslations } from 'next-intl';
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
import { useSessionQuery } from '@/lib/api/session-queries';
import { useWorkspaces } from '@/lib/api/workspace-queries';

/**
 * The one-time setup: a database with the two columns the matcher reads, and
 * `entities.databaseId` pointing at it (issue #47).
 *
 * Administrator-only at the API. Since the session carries `role`, a reader who
 * may not do this is told so instead of being handed a button that fails: the
 * sentence still says what is missing and who can supply it, which is more than
 * a refusal after the click ever said. The form is not hidden for secrecy -- the
 * API refuses the route regardless -- but because an offer nobody can accept is
 * a worse lie than no offer.
 *
 * Until this has been done, every entity call answers with `databaseId: null`
 * and an empty list. Before this panel existed there was no way to do it in the
 * browser at all: the route was exempt from the tool catalogue for good reasons
 * and nothing in the UI called it, so a fresh deployment had an entity layer
 * that could only be switched on with a hand-written request.
 */
export function EntityDatabaseSetup() {
  const t = useTranslations('entities.setup');
  const workspaces = useWorkspaces();
  const session = useSessionQuery();
  const provision = useProvisionEntityDatabase();
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);

  const chosen = workspaceId ?? workspaces.data?.[0]?.id ?? null;
  const mayProvision = session.data?.user?.role === 'admin';

  return (
    <Alert className="mt-6">
      <AlertDescription>
        <p>{t('missing')}</p>
        {mayProvision ? null : <p className="mt-2 text-muted-foreground">{t('adminOnly')}</p>}
        {mayProvision ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select value={chosen ?? ''} onValueChange={setWorkspaceId}>
              <SelectTrigger className="w-56" data-testid="entity-database-workspace">
                <SelectValue>
                  {() =>
                    workspaces.data?.find((workspace) => workspace.id === chosen)?.name ??
                    t('chooseWorkspace')
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
                provision.mutate({
                  workspaceId: chosen,
                  parentId: null,
                  title: t('databaseTitle'),
                });
              }}
            >
              {t('create')}
            </Button>
          </div>
        ) : null}
        {provision.isError ? (
          <p role="alert" className="mt-2 text-xs text-destructive-text">
            {provision.error.message}
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
