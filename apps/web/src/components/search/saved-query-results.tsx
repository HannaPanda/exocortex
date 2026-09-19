'use client';

import Link from 'next/link';
import * as React from 'react';

import { type SavedQueryDisplay, type SavedQueryHit } from '@exocortex/contracts';
import { cn, EmptyState } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { documentHref } from '@/lib/document-href';
import { formatRelativeTime } from '@/lib/relative-time';

/**
 * The answer to a saved query, in the three layouts `SavedQueryDisplay` offers
 * (issue #74).
 *
 * One component for the search area, the smart view and the query block,
 * because the three differ in what surrounds the list and in nothing about the
 * list itself. A hit here is not a row of anything: it is a page somewhere in
 * the workspace, so every layout leads with the icon and the title and offers
 * the path, and none of them pretends to be a table of properties.
 */

export interface SavedQueryResultsProps {
  hits: readonly SavedQueryHit[];
  display: SavedQueryDisplay;
  truncated: boolean;
  /** Shown instead of the list when there is nothing. */
  emptyDescription?: string;
  className?: string;
}

/** The snippet arrives with `<mark>` around what matched; it is rendered as text. */
function plainSnippet(snippet: string): string {
  return snippet.replace(/<\/?mark>/g, '');
}

function pathLabel(hit: SavedQueryHit): string {
  return hit.path.length === 0 ? 'oberste Ebene' : hit.path.map((entry) => entry.title).join(' › ');
}

export function SavedQueryResults({
  hits,
  display,
  truncated,
  emptyDescription,
  className,
}: SavedQueryResultsProps) {
  if (hits.length === 0) {
    return (
      <EmptyState
        title="Keine Treffer"
        description={
          emptyDescription ??
          'Zu dieser Abfrage gibt es gerade nichts. Das kann sich morgen ändern, die Suche bleibt gespeichert.'
        }
      />
    );
  }

  return (
    <div className={className} data-testid="saved-query-results">
      {display.layout === 'CARDS' ? (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {hits.map((hit) => (
            <li key={hit.documentId}>
              <HitCard hit={hit} display={display} />
            </li>
          ))}
        </ul>
      ) : display.layout === 'TABLE' ? (
        <HitTable hits={hits} display={display} />
      ) : (
        <ul className="divide-y divide-border">
          {hits.map((hit) => (
            <li key={hit.documentId}>
              <HitRow hit={hit} display={display} />
            </li>
          ))}
        </ul>
      )}

      {truncated ? (
        <p className="mt-2 px-1 text-xs text-muted-foreground">
          Das ist nicht die ganze Antwort. Erhöhe das Limit der Abfrage, um mehr zu sehen.
        </p>
      ) : null}
    </div>
  );
}

function HitRow({ hit, display }: { hit: SavedQueryHit; display: SavedQueryDisplay }) {
  return (
    <Link
      href={documentHref(hit.workspaceId, hit.documentId, hit.type)}
      data-testid={`saved-query-hit-${hit.documentId}`}
      className="flex items-start gap-2 rounded-md px-2 py-2 hover:bg-accent/60"
    >
      <DocumentIcon
        icon={hit.icon}
        iconColor={hit.iconColor}
        type={hit.type}
        className="mt-0.5 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{hit.title}</span>
          {display.showUpdatedAt ? (
            <span className="exocortex-numeric text-xs text-muted-foreground">
              {formatRelativeTime(hit.updatedAt)}
            </span>
          ) : null}
          {hit.archivedAt === null ? null : (
            <span className="text-xs text-muted-foreground">im Papierkorb</span>
          )}
        </span>
        {display.showPath ? (
          <span className="block truncate text-xs text-muted-foreground">{pathLabel(hit)}</span>
        ) : null}
        {display.showSnippet && hit.snippet.length > 0 ? (
          <span className="mt-0.5 block line-clamp-2 text-sm text-muted-foreground">
            {plainSnippet(hit.snippet)}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function HitCard({ hit, display }: { hit: SavedQueryHit; display: SavedQueryDisplay }) {
  return (
    <Link
      href={documentHref(hit.workspaceId, hit.documentId, hit.type)}
      data-testid={`saved-query-hit-${hit.documentId}`}
      className={cn(
        'flex h-full flex-col gap-1 rounded-md border border-border p-3',
        'hover:border-primary/40 hover:bg-accent/40',
      )}
    >
      <span className="flex items-center gap-2">
        <DocumentIcon
          icon={hit.icon}
          iconColor={hit.iconColor}
          type={hit.type}
          className="shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate font-medium">{hit.title}</span>
      </span>
      {display.showPath ? (
        <span className="truncate text-xs text-muted-foreground">{pathLabel(hit)}</span>
      ) : null}
      {display.showSnippet && hit.snippet.length > 0 ? (
        <span className="line-clamp-3 text-sm text-muted-foreground">
          {plainSnippet(hit.snippet)}
        </span>
      ) : null}
      {display.showUpdatedAt ? (
        <span className="exocortex-numeric mt-auto pt-1 text-xs text-muted-foreground">
          {formatRelativeTime(hit.updatedAt)}
        </span>
      ) : null}
    </Link>
  );
}

function HitTable({
  hits,
  display,
}: {
  hits: readonly SavedQueryHit[];
  display: SavedQueryDisplay;
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground uppercase">
          <tr>
            <th className="px-3 py-2 font-medium">Seite</th>
            {display.showPath ? <th className="px-3 py-2 font-medium">Ort</th> : null}
            {display.showUpdatedAt ? <th className="px-3 py-2 font-medium">Geändert</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {hits.map((hit) => (
            <tr key={hit.documentId} className="hover:bg-accent/40">
              <td className="px-3 py-2">
                <Link
                  href={documentHref(hit.workspaceId, hit.documentId, hit.type)}
                  data-testid={`saved-query-hit-${hit.documentId}`}
                  className="flex items-center gap-2"
                >
                  <DocumentIcon
                    icon={hit.icon}
                    iconColor={hit.iconColor}
                    type={hit.type}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 truncate">{hit.title}</span>
                </Link>
              </td>
              {display.showPath ? (
                <td className="px-3 py-2 text-xs text-muted-foreground">{pathLabel(hit)}</td>
              ) : null}
              {display.showUpdatedAt ? (
                <td className="exocortex-numeric px-3 py-2 text-xs text-muted-foreground">
                  {formatRelativeTime(hit.updatedAt)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
