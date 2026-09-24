'use client';

import { ChevronDownIcon, ChevronUpIcon, ListFilterIcon, SearchIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';

import { type SavedQuery } from '@exocortex/contracts';
import { Button, cn } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useReorderSavedQuery, useSavedQueries } from '@/lib/api/saved-query-queries';

/**
 * The smart views in the navigation (issue #74).
 *
 * A saved query becomes an entry here by carrying `inSidebar`, and nothing
 * else about it changes. It sits under the page tree rather than in it,
 * because a query is not a page and putting it among the pages would invite
 * dragging one into the other.
 *
 * The section is only drawn when there is something in it. "Suche" below it is
 * always there: the search area is where a smart view comes from, and an empty
 * heading with no door under it teaches nobody where to go.
 *
 * Order is changed with two buttons rather than by dragging. The list is short
 * and it lives in a column that already has a drag interaction for pages;
 * a second one with different rules in the same column is how a drop lands
 * somewhere nobody meant. The buttons also work from the keyboard, which the
 * page tree needed a whole context menu to achieve.
 */
export function SmartViews({ workspaceId }: { workspaceId: string }) {
  const params = useParams<{ savedQueryId?: string }>();
  const savedQueries = useSavedQueries(workspaceId);
  const reorder = useReorderSavedQuery(workspaceId);
  const views = (savedQueries.data?.savedQueries ?? []).filter((entry) => entry.inSidebar);

  const move = (view: SavedQuery, direction: -1 | 1): void => {
    const index = views.findIndex((entry) => entry.id === view.id);
    const neighbour = views[index + direction];
    if (neighbour === undefined) return;
    void reorder.mutateAsync({
      savedQueryId: view.id,
      request: direction === -1 ? { beforeId: neighbour.id } : { afterId: neighbour.id },
    });
  };

  return (
    <div className="mt-2 border-t border-border pt-2" data-testid="smart-views">
      {views.length === 0 ? null : (
        <ul className="mb-1">
          {views.map((view, index) => (
            <li key={view.id} className="group/view flex items-center gap-0.5">
              <Link
                href={`/arbeitsbereich/${workspaceId}/suche/${view.id}`}
                data-testid={`smart-view-${view.id}`}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-accent/60',
                  params.savedQueryId === view.id
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                {view.icon === null ? (
                  <ListFilterIcon className="size-3.5 shrink-0" />
                ) : (
                  <DocumentIcon icon={view.icon} iconColor={view.iconColor} type="PAGE" />
                )}
                <span className="min-w-0 flex-1 truncate">{view.name}</span>
              </Link>

              {/* Hidden until the row is hovered or something in it has focus,
                  so eight rows are eight names and not sixteen buttons. A
                  touch screen has no hover, so there they always show. */}
              <span className="flex opacity-0 transition-opacity group-hover/view:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`„${view.name}“ nach oben`}
                  data-testid={`smart-view-up-${view.id}`}
                  disabled={index === 0 || reorder.isPending}
                  onClick={() => move(view, -1)}
                >
                  <ChevronUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`„${view.name}“ nach unten`}
                  data-testid={`smart-view-down-${view.id}`}
                  disabled={index === views.length - 1 || reorder.isPending}
                  onClick={() => move(view, 1)}
                >
                  <ChevronDownIcon />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <Link
        href={`/arbeitsbereich/${workspaceId}/suche`}
        data-testid="open-search-page"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      >
        <SearchIcon className="size-3.5" />
        Suche und gespeicherte Suchen
      </Link>
    </div>
  );
}
