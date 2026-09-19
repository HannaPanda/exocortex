'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';

import { type PublicShareResponse } from '@exocortex/contracts';
import { EmptyState, ExocortexWordmark, LoadingState } from '@exocortex/ui';

import { ReadingMarkdown } from '@/components/ai/chat-markdown';
import { apiRequest } from '@/lib/api/client';

/**
 * A page behind a public link (issue #83, ADR-044).
 *
 * Deliberately not the application: no navigation, no search, no account, no
 * editor. Somebody arriving here followed an address somebody else sent them,
 * and everything this page offers is the page itself, the way back up inside
 * the shared branch, and the sub-pages the link covers.
 *
 * It renders Markdown that the API derived from the canonical Yjs state
 * (ADR-007), through the same node renderer the chat uses -- so there is no
 * path from stored content to raw HTML here either.
 */
export function PublicSharePage({ token }: { token: string }) {
  const [documentId, setDocumentId] = React.useState<string | null>(null);

  const page = useQuery({
    queryKey: ['public-share', token, documentId ?? 'root'],
    queryFn: () =>
      apiRequest<PublicShareResponse>(
        documentId === null
          ? `/api/share/${encodeURIComponent(token)}`
          : `/api/share/${encodeURIComponent(token)}/pages/${documentId}`,
      ),
    retry: false,
  });

  if (page.isPending) return <LoadingState label="Seite wird geladen …" />;
  if (page.isError) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-6 px-4">
        <ExocortexWordmark className="h-8" />
        <EmptyState
          title="Dieser Link führt nicht mehr zu einer Seite"
          description="Er wurde zurückgezogen, ist abgelaufen, oder er war nie gültig. Frag die Person, von der du ihn hast."
        />
      </div>
    );
  }

  const { page: shared } = page.data;

  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2 border-b border-border pb-4">
        <div className="flex items-center justify-between gap-3">
          <ExocortexWordmark className="h-6" />
          <span className="text-xs text-muted-foreground">
            Geteilt aus „{shared.workspaceName}“ von {shared.sharedByName}
          </span>
        </div>
        {shared.path.length > 1 ? (
          <nav aria-label="Pfad" className="flex flex-wrap gap-1 text-xs text-muted-foreground">
            {shared.path.slice(0, -1).map((entry) => (
              <React.Fragment key={entry.documentId}>
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() =>
                    setDocumentId(
                      entry.documentId === shared.path[0]?.documentId ? null : entry.documentId,
                    )
                  }
                >
                  {entry.title}
                </button>
                <span aria-hidden>/</span>
              </React.Fragment>
            ))}
          </nav>
        ) : null}
        <h1 className="text-2xl font-semibold">
          {shared.icon === null ? null : <span className="mr-2">{shared.icon}</span>}
          {shared.title}
        </h1>
      </header>

      <article className="text-sm leading-relaxed">
        {shared.markdown.trim().length === 0 ? (
          <p className="text-sm text-muted-foreground">Diese Seite ist leer.</p>
        ) : (
          <ReadingMarkdown content={shared.markdown} />
        )}
      </article>

      {shared.children.length === 0 ? null : (
        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <h2 className="text-sm font-semibold">Unterseiten</h2>
          <ul className="flex flex-col gap-1">
            {shared.children.map((child) => (
              <li key={child.documentId}>
                <button
                  type="button"
                  className="text-sm text-primary-text underline underline-offset-2"
                  onClick={() => setDocumentId(child.documentId)}
                >
                  {child.icon === null ? null : <span className="mr-1">{child.icon}</span>}
                  {child.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-auto border-t border-border pt-4 text-xs text-muted-foreground">
        Diese Seite wurde als Link geteilt. Sie ist schreibgeschützt.{' '}
        <Link href="/" className="underline underline-offset-2">
          eXocortex
        </Link>{' '}
        ist selbst gehostet.
      </footer>
    </div>
  );
}
