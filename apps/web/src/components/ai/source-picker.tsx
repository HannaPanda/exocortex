'use client';

import { FileTextIcon, ListFilterIcon, TableIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AddAiConversationSourceRequest } from '@exocortex/contracts';
import { type CommandItem, CommandPalette } from '@exocortex/ui';

import { useDatabaseViews } from '@/lib/api/database-queries';
import { useSavedQueries } from '@/lib/api/saved-query-queries';
import { useSearch } from '@/lib/api/search-queries';

export interface SourcePickerProps {
  workspaceId: string;
  /** The page the panel is standing on; its views are offered without searching. */
  openDocumentId: string | null;
  openDocumentIsCollection: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (request: AddAiConversationSourceRequest) => void;
}

/**
 * The menu behind the plus in the chip row (issue #75).
 *
 * Everything is pinned as a name first (`mode: 'REFERENCE'`), never with its
 * text: pinning is one click and costs nothing, and paying for a source on
 * every turn is a second, deliberate decision made in the chip's own menu.
 * That order matters, because the alternative -- embedding by default -- makes
 * a chip row somebody assembled in ten seconds quietly expensive.
 *
 * A database is offered as one entry rather than one per view, and the server
 * pins its first view: rows only mean something through a view's filters, and
 * picking the right one is what the chip's menu is for afterwards.
 */
export function SourcePicker({
  workspaceId,
  openDocumentId,
  openDocumentIsCollection,
  open,
  onOpenChange,
  onPick,
}: SourcePickerProps) {
  const t = useTranslations('ai.sourcePicker');
  const [query, setQuery] = React.useState('');
  const search = useSearch(open ? workspaceId : undefined, query);
  // Only while the menu is open: a workspace's stored questions are not worth a
  // request on every panel render, and the view list belongs to one page.
  const savedQueries = useSavedQueries(open ? workspaceId : undefined);
  const views = useDatabaseViews(
    open && openDocumentIsCollection && openDocumentId !== null ? openDocumentId : undefined,
  );

  const pick = React.useCallback(
    (request: AddAiConversationSourceRequest) => {
      onOpenChange(false);
      setQuery('');
      onPick(request);
    },
    [onOpenChange, onPick],
  );

  const items = React.useMemo<CommandItem[]>(() => {
    const entries: CommandItem[] = [];

    for (const view of views.data ?? []) {
      entries.push({
        id: `view-${view.id}`,
        group: t('groupViews'),
        label: view.name,
        icon: <TableIcon className="size-4 text-muted-foreground" />,
        onSelect: () =>
          pick({
            kind: 'DATABASE_VIEW',
            documentId: openDocumentId ?? undefined,
            databaseViewId: view.id,
            mode: 'REFERENCE',
          }),
      });
    }

    for (const result of search.data?.results ?? []) {
      const collection = result.type === 'COLLECTION';
      entries.push({
        id: `page-${result.documentId}`,
        group: t('groupPages'),
        label: result.title.trim().length === 0 ? t('untitled') : result.title,
        hint: result.path.map((entry) => entry.title).join(' / '),
        icon: collection ? (
          <TableIcon className="size-4 text-muted-foreground" />
        ) : (
          <FileTextIcon className="size-4 text-muted-foreground" />
        ),
        onSelect: () =>
          pick({
            kind: collection ? 'DATABASE_VIEW' : 'PAGE',
            documentId: result.documentId,
            mode: 'REFERENCE',
          }),
      });
    }

    for (const savedQuery of savedQueries.data?.savedQueries ?? []) {
      entries.push({
        id: `query-${savedQuery.id}`,
        group: t('groupSavedQueries'),
        label: savedQuery.name,
        hint: savedQuery.description ?? undefined,
        icon: <ListFilterIcon className="size-4 text-muted-foreground" />,
        onSelect: () =>
          pick({ kind: 'SAVED_QUERY', savedQueryId: savedQuery.id, mode: 'REFERENCE' }),
      });
    }

    return entries;
  }, [openDocumentId, pick, savedQueries.data, search.data, t, views.data]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      items={items}
      placeholder={t('placeholder')}
      emptyLabel={t('empty')}
      footer={<span>{t('footer')}</span>}
    />
  );
}
