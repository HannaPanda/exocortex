'use client';

import { PlusIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { type CommandItem,CommandPalette } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useCreateDocument, useSearch } from '@/lib/api/queries';

export interface SearchCommandProps {
  workspaceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Command menu and full-text search in one surface.
 *
 * Search results come from the PostgreSQL adapter through
 * `GET /workspaces/:id/search`; snippets are produced server-side.
 */
export function SearchCommand({ workspaceId, open, onOpenChange }: SearchCommandProps) {
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const search = useSearch(workspaceId ?? undefined, query);
  const createDocument = useCreateDocument(workspaceId ?? undefined);

  const items = React.useMemo<CommandItem[]>(() => {
    const actions: CommandItem[] = [];
    if (workspaceId !== null) {
      actions.push({
        id: 'action-create-page',
        group: 'Aktionen',
        label: 'Neue Seite anlegen',
        icon: <PlusIcon className="size-4 text-muted-foreground" />,
        onSelect: () => {
          void createDocument
            .mutateAsync({ title: 'Unbenannte Seite', type: 'PAGE', parentId: null })
            .then((document) => {
              onOpenChange(false);
              router.push(`/arbeitsbereich/${workspaceId}/seite/${document.id}`);
            });
        },
      });
    }

    const results = (search.data?.results ?? []).map<CommandItem>((result) => ({
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
      onSelect: () => {
        onOpenChange(false);
        router.push(`/arbeitsbereich/${result.workspaceId}/seite/${result.documentId}`);
      },
    }));

    return [...actions, ...results];
  }, [createDocument, onOpenChange, router, search.data, workspaceId]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      items={items}
      emptyLabel={
        query.trim().length <= 1 ? 'Mindestens zwei Zeichen eingeben' : 'Keine Seiten gefunden'
      }
      footer={
        // A count, a duration and an engine name: a readout, so it gets the
        // instrument face. The fallback sentence is prose and stays sans.
        search.data !== undefined ? (
          <span className="exocortex-numeric">
            {`${search.data.results.length} Treffer · ${search.data.tookMs} ms · ${search.data.adapter}`}
          </span>
        ) : (
          <span>Volltextsuche über alle Seiten dieses Arbeitsbereichs</span>
        )
      }
    />
  );
}
