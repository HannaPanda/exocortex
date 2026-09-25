'use client';

import Link from 'next/link';
import * as React from 'react';

import { type DocumentDetail } from '@exocortex/contracts';
import { TruncatedText } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';

/**
 * Where the page sits, as a line of links.
 *
 * Its own component, and since issue #97 its own file, because a breadcrumb is
 * the one part of the top bar that is pure rendering: it holds no state and
 * calls nothing.
 *
 * `breadcrumb` is already cut for a reader who is here through a share (issue
 * #83, ADR-044) -- the API stops it at the shared page -- so nothing here has
 * to know that shares exist.
 */
export function PageBreadcrumb({
  workspaceId,
  workspaceName,
  detail,
}: {
  workspaceId: string;
  workspaceName: string | undefined;
  detail: DocumentDetail;
}) {
  return (
    <nav
      aria-label="Pfad"
      className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
    >
      {/* The workspace starts the path, so its overview is one click away
          instead of two through the switcher. It is skipped while the list
          is still loading rather than shown under a placeholder name. */}
      {workspaceName === undefined ? null : (
        <>
          <Link
            href={`/arbeitsbereich/${workspaceId}`}
            className="flex max-w-32 items-center gap-1 truncate hover:text-foreground"
            data-testid="breadcrumb-workspace"
          >
            <TruncatedText text={workspaceName} side="bottom" />
          </Link>
          <span aria-hidden>/</span>
        </>
      )}
      {detail.breadcrumb.map((entry) => (
        <React.Fragment key={entry.id}>
          <Link
            href={`/arbeitsbereich/${workspaceId}/seite/${entry.id}`}
            className="flex max-w-32 items-center gap-1 truncate hover:text-foreground"
          >
            {/* Only a chosen symbol, never the default one: a path is a line
                  of text, and a file icon in front of every step would say
                  nothing the path does not already say. */}
            {entry.icon === null ? null : (
              <DocumentIcon
                icon={entry.icon}
                iconColor={entry.iconColor}
                type="PAGE"
                className="size-3.5 text-xs"
              />
            )}
            <TruncatedText text={entry.title} side="bottom" />
          </Link>
          <span aria-hidden>/</span>
        </React.Fragment>
      ))}
      <TruncatedText text={detail.title} side="bottom" className="max-w-40 text-foreground" />
    </nav>
  );
}
