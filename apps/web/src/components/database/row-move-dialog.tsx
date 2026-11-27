'use client';

import { FolderInputIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type CommandItem, CommandPalette } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useGuardedMove } from '@/components/shell/guarded-move';
import { useSearch } from '@/lib/api/search-queries';

/**
 * "Verschieben" in a row's menu (issue #244): a row is a page (ADR-011), so
 * moving it is moving a page, found by searching for where it should go.
 *
 * The same guarded move the palette uses: a target inside a shared branch asks
 * first, because moving the row there shares it. A project is no place for a
 * page, and the row cannot move into itself or into the database it is in.
 */
export function RowMoveDialog({
  workspaceId,
  databaseId,
  row,
  onClose,
}: {
  workspaceId: string;
  databaseId: string;
  row: { id: string; title: string } | null;
  onClose: () => void;
}) {
  const t = useTranslations('database.rowActions');
  const [query, setQuery] = React.useState('');
  const search = useSearch(row === null ? undefined : workspaceId, query);
  // The row being moved outlives the search: closing the search is what
  // starts the move, and the share warning that may follow still has to know
  // which page it is about.
  const [target, setTarget] = React.useState(row);
  if (row !== null && row.id !== target?.id) setTarget(row);
  const guardedMove = useGuardedMove({
    workspaceId,
    documentId: target?.id ?? '',
    title: target?.title ?? '',
  });

  const close = React.useCallback((): void => {
    setQuery('');
    onClose();
  }, [onClose]);

  const items = React.useMemo<CommandItem[]>(() => {
    if (row === null) return [];
    const root: CommandItem = {
      id: 'row-move-root',
      group: t('moveGroup'),
      label: t('moveRoot'),
      icon: <FolderInputIcon className="size-4 text-muted-foreground" />,
      onSelect: () => {
        close();
        guardedMove.propose({ parentId: null, title: t('moveRoot') });
      },
    };
    const hits = (search.data?.results ?? [])
      .filter(
        (hit) =>
          hit.type !== 'PROJECT' && hit.documentId !== row.id && hit.documentId !== databaseId,
      )
      .map<CommandItem>((hit) => {
        const title = hit.title.trim().length === 0 ? t('untitled') : hit.title;
        return {
          id: hit.documentId,
          group: t('moveGroup'),
          label: title,
          hint: hit.path.map((entry) => entry.title).join(' / '),
          icon: (
            <DocumentIcon
              icon={hit.icon}
              iconColor={hit.iconColor}
              type={hit.type}
              className="text-muted-foreground"
            />
          ),
          onSelect: () => {
            close();
            guardedMove.propose({ parentId: hit.documentId, title });
          },
        };
      });
    return query.trim().length > 1 ? hits : [root];
  }, [close, databaseId, guardedMove, query, row, search.data, t]);

  return (
    <>
      <CommandPalette
        open={row !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        query={query}
        onQueryChange={setQuery}
        items={items}
        placeholder={t('movePlaceholder', { title: row?.title ?? '' })}
        emptyLabel={query.trim().length > 1 ? t('moveEmpty') : t('moveTypeToSearch')}
      />
      {guardedMove.dialog}
    </>
  );
}
