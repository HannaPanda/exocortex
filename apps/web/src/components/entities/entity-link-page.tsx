'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useLinkEntityPage } from '@/lib/api/entity-queries';
import { useSearch } from '@/lib/api/search-queries';
import { useWorkspaces } from '@/lib/api/workspace-queries';

/**
 * Drawing the edge by hand (issue #47).
 *
 * The extraction pass matches names, and a page can be about something without
 * ever spelling it out: the notes from a meeting about a host that only ever
 * says "the server". No amount of matching finds that, so somebody has to say
 * so -- and a manual edge then survives every re-extraction, unlike a match.
 *
 * Search rather than a tree, and a workspace picker beside it, because the page
 * that belongs to an entity is rarely in the workspace the entity lives in.
 */
export function EntityLinkPage({ entityId }: { entityId: string }) {
  const t = useTranslations('entities.linkPage');
  const workspaces = useWorkspaces();
  const link = useLinkEntityPage();

  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [note, setNote] = React.useState('');

  const chosen = workspaceId ?? workspaces.data?.[0]?.id ?? null;
  const results = useSearch(chosen ?? undefined, query);

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-3">
      <h3 className="text-sm font-medium">{t('title')}</h3>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`link-workspace-${entityId}`}>{t('workspace')}</Label>
          <Select value={chosen ?? ''} onValueChange={setWorkspaceId}>
            <SelectTrigger
              id={`link-workspace-${entityId}`}
              className="w-44"
              data-testid="entity-link-workspace"
            >
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
        </div>
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor={`link-query-${entityId}`}>{t('search')}</Label>
          <Input
            id={`link-query-${entityId}`}
            value={query}
            placeholder={t('searchPlaceholder')}
            data-testid="entity-link-query"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`link-note-${entityId}`}>{t('note')}</Label>
        <Input
          id={`link-note-${entityId}`}
          value={note}
          placeholder={t('notePlaceholder')}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>

      {(results.data?.results ?? []).slice(0, 5).map((result) => (
        <div key={result.documentId} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{result.title}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={link.isPending}
            data-testid="entity-link-submit"
            onClick={() =>
              void link
                .mutateAsync({
                  entityId,
                  request: { documentId: result.documentId, note: note.trim() },
                })
                .then(() => {
                  setQuery('');
                  setNote('');
                })
            }
          >
            {t('submit')}
          </Button>
        </div>
      ))}

      {link.isError ? (
        <p role="alert" className="text-xs text-destructive-text">
          {link.error.message}
        </p>
      ) : null}
    </section>
  );
}
