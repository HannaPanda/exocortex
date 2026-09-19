'use client';

import { ListFilterIcon, SearchIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';

import { cn } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useSavedQueries } from '@/lib/api/saved-query-queries';

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
 */
export function SmartViews({ workspaceId }: { workspaceId: string }) {
  const params = useParams<{ savedQueryId?: string }>();
  const savedQueries = useSavedQueries(workspaceId);
  const views = (savedQueries.data?.savedQueries ?? []).filter((entry) => entry.inSidebar);

  return (
    <div className="mt-2 border-t border-border pt-2" data-testid="smart-views">
      {views.length === 0 ? null : (
        <ul className="mb-1">
          {views.map((view) => {
            const active = params.savedQueryId === view.id;
            return (
              <li key={view.id}>
                <Link
                  href={`/arbeitsbereich/${workspaceId}/suche/${view.id}`}
                  data-testid={`smart-view-${view.id}`}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-accent/60',
                    active ? 'bg-accent text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {view.icon === null ? (
                    <ListFilterIcon className="size-3.5 shrink-0" />
                  ) : (
                    <DocumentIcon icon={view.icon} iconColor={view.iconColor} type="PAGE" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{view.name}</span>
                </Link>
              </li>
            );
          })}
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
