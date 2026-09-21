'use client';

import { ClockIcon, ListFilterIcon, PlusIcon, SlidersHorizontalIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { type CommandItem, CommandPalette } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { type PaletteCommand } from '@/components/shell/palette-commands';
import { useCreateDocument } from '@/lib/api/document-queries';
import { useSavedQueries } from '@/lib/api/saved-query-queries';
import { useSearch } from '@/lib/api/search-queries';
import { useWorkspaceOverview } from '@/lib/api/workspace-queries';
import { documentHref } from '@/lib/document-href';

export interface SearchCommandProps {
  workspaceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The shell's own commands, so the palette is one (issue #115). */
  commands: readonly PaletteCommand[];
}

/** Whether a row answers what has been typed. An empty field matches all. */
function matcher(query: string): (...haystack: readonly string[]) => boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return () => true;
  return (...haystack) => haystack.some((text) => text.toLowerCase().includes(needle));
}

/**
 * Command menu and full-text search in one surface.
 *
 * Search results come from the PostgreSQL adapter through
 * `GET /workspaces/:id/search`; snippets are produced server-side.
 *
 * What it shows before a key is pressed is the point (issue #115). It used to
 * show "Mindestens zwei Zeichen eingeben", which asks the reader to remember a
 * title before it will help -- in a product whose accessibility requirement is
 * that no surface may demand you remember where you were, and whose second
 * purpose after writing is finding things again. So an empty field now answers
 * with the pages last worked on: the one list that needs no memory at all, and
 * the same data the overview's "Weitermachen" is built from.
 *
 * The order says what a keystroke does. With nothing typed, the recent pages
 * come first, so Enter carries on where you left off rather than -- as it did
 * -- creating an untitled page. With something typed, whatever commands match
 * it come first, because typing a command's name is asking for the command;
 * the pages follow.
 */
export function SearchCommand({ workspaceId, open, onOpenChange, commands }: SearchCommandProps) {
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const search = useSearch(workspaceId ?? undefined, query);
  const createDocument = useCreateDocument(workspaceId ?? undefined);
  // Both only while the palette is open. The overview is usually already in the
  // cache from the workspace's landing page, so opening the palette costs
  // nothing; a workspace's stored questions are small but not worth a request
  // on every page load.
  const activeWorkspace = open && workspaceId !== null ? workspaceId : undefined;
  const savedQueries = useSavedQueries(activeWorkspace);
  const overview = useWorkspaceOverview(activeWorkspace);

  // Emptying the field on close: a palette that reopens holding the last
  // question would show yesterday's answer above today's recent pages.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open && query !== '') setQuery('');
  }

  const typed = query.trim().length > 0;

  const items = React.useMemo<CommandItem[]>(() => {
    const matches = matcher(query);
    const go = (href: string): void => {
      onOpenChange(false);
      router.push(href);
    };

    const actions: CommandItem[] = [];
    if (workspaceId !== null) {
      if (matches('Neue Seite anlegen', 'erstellen', 'schreiben')) {
        actions.push({
          id: 'action-create-page',
          group: 'Aktionen',
          label: 'Neue Seite anlegen',
          icon: <PlusIcon className="size-4 text-muted-foreground" />,
          onSelect: () => {
            void createDocument
              .mutateAsync({ title: 'Unbenannte Seite', type: 'PAGE', parentId: null })
              .then((document) => {
                go(`/arbeitsbereich/${workspaceId}/seite/${document.id}`);
              });
          },
        });
      }
      if (matches('Erweiterte Suche mit Filtern', 'finden')) {
        const href = `/arbeitsbereich/${workspaceId}/suche`;
        actions.push({
          id: 'action-open-search-page',
          group: 'Aktionen',
          label: 'Erweiterte Suche mit Filtern',
          icon: <SlidersHorizontalIcon className="size-4 text-muted-foreground" />,
          link: <Link href={href} />,
          onSelect: () => go(href),
        });
      }
    }

    for (const command of commands) {
      if (!matches(command.label, ...command.keywords)) continue;
      actions.push({
        id: command.id,
        group: 'Aktionen',
        label: command.label,
        hint: command.hint,
        icon: command.icon,
        onSelect: () => {
          onOpenChange(false);
          command.run();
        },
      });
    }

    // The stored questions, so a saved search is reachable by name from the
    // same keystroke everything else is.
    const stored = (savedQueries.data?.savedQueries ?? [])
      .filter((savedQuery) => matches(savedQuery.name, savedQuery.description ?? ''))
      .map<CommandItem>((savedQuery) => {
        const href = `/arbeitsbereich/${savedQuery.workspaceId}/suche/${savedQuery.id}`;
        return {
          id: `saved-query-${savedQuery.id}`,
          group: 'Gespeicherte Suchen',
          label: savedQuery.name,
          hint: savedQuery.description ?? undefined,
          icon: <ListFilterIcon className="size-4 text-muted-foreground" />,
          link: <Link href={href} />,
          onSelect: () => go(href),
        };
      });

    // With nothing typed there is nothing to search for, so the palette answers
    // with the pages this workspace was last working on.
    const recent = typed
      ? []
      : (overview.data?.recentlyEdited ?? []).map<CommandItem>((document) => {
          const href = documentHref(workspaceId ?? '', document.id, document.type);
          return {
            id: `recent-${document.id}`,
            group: 'Zuletzt bearbeitet',
            label: document.title,
            // The path, because a workspace can hold three pages called
            // "Notizen" and a bare title makes the reader guess which one.
            hint:
              document.path.length === 0
                ? undefined
                : document.path.map((entry) => entry.title).join(' / '),
            icon: (
              <DocumentIcon
                icon={document.icon}
                iconColor={document.iconColor}
                type={document.type}
                className="text-muted-foreground"
              />
            ),
            link: <Link href={href} data-testid={`recent-result-${document.id}`} />,
            onSelect: () => go(href),
          };
        });

    const results = (search.data?.results ?? []).map<CommandItem>((result) => {
      const href = documentHref(result.workspaceId, result.documentId, result.type);
      return {
        id: result.documentId,
        group: 'Seiten',
        label: result.title,
        hint: result.snippet.replace(/<\/?mark>/g, '').slice(0, 60),
        icon: (
          <DocumentIcon
            icon={result.icon}
            iconColor={result.iconColor}
            type={result.type}
            className="text-muted-foreground"
          />
        ),
        // A real anchor, so a hit can be opened in a new tab or its address
        // copied; `onSelect` below is the same route for the keyboard.
        link: (
          <Link
            href={href}
            data-testid={`search-result-${result.documentId}`}
            onClick={(event) => {
              // A modified click opens a background tab: the palette is still
              // the surface the reader is working in and must stay open.
              if (event.ctrlKey || event.metaKey || event.shiftKey) return;
              onOpenChange(false);
            }}
          />
        ),
        onSelect: () => go(href),
      };
    });

    // Enter lands on the first row: carry on where you were when nothing is
    // typed, run the command you named when something is.
    return typed ? [...actions, ...stored, ...results] : [...recent, ...actions, ...stored];
  }, [
    commands,
    createDocument,
    onOpenChange,
    overview.data,
    query,
    router,
    savedQueries.data,
    search.data,
    typed,
    workspaceId,
  ]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      items={items}
      emptyLabel={
        query.trim().length === 1 ? 'Für Seiten mindestens zwei Zeichen eingeben' : 'Keine Treffer'
      }
      footer={
        // A count, a duration and an engine name: a readout, so it gets the
        // instrument face. The fallback sentence is prose and stays sans.
        search.data !== undefined && query.trim().length > 1 ? (
          <span className="exocortex-numeric">
            {`${search.data.results.length} Treffer · ${search.data.tookMs} ms · ${search.data.adapter}`}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <ClockIcon className="size-3.5" aria-hidden />
            Zuletzt bearbeitet, oder tippen für die Volltextsuche
          </span>
        )
      }
    />
  );
}
