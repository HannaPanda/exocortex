'use client';

import {
  CopyIcon,
  PencilLineIcon,
  SparklesIcon,
  SquareCheckIcon,
  SquareIcon,
  Trash2Icon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DatabaseProperty } from '@exocortex/contracts';

import { useLatest, usePaletteContribution } from './contributions';
import { keywordsOf, type PaletteCommand } from './palette-command';

const ICON = 'size-4 text-muted-foreground';
const NONE: readonly PaletteCommand[] = [];

export interface RowSelectionHandlers {
  selectAll: () => void;
  clear: () => void;
  duplicate: () => void;
  trash: () => void;
  edit: (property: DatabaseProperty) => void;
  /** Fill the selection's cells of a column with its AI instruction (issue #237). */
  aiFill: (property: DatabaseProperty) => void;
  /** Fill a whole column with its AI instruction (issue #237). */
  aiFillColumn: (property: DatabaseProperty) => void;
}

/**
 * What the palette offers for a table's selection (issue #244): selecting
 * every row, and while rows are selected what the selection bar does --
 * "Eigenschaft für Auswahl setzen → Status", duplicate, the trash, letting go.
 *
 * Only on the database that is the page, like the rest of its commands: an
 * embedded one is a block in somebody's text.
 */
export function useRowSelectionCommands({
  enabled,
  selectedCount,
  properties,
  aiColumns = [],
  handlers,
}: {
  enabled: boolean;
  selectedCount: number;
  properties: readonly DatabaseProperty[];
  /** Columns with an AI instruction (issue #237). */
  aiColumns?: readonly DatabaseProperty[];
  handlers: RowSelectionHandlers;
}): void {
  const t = useTranslations('shell.paletteCommands.rowSelection');
  const latest = useLatest(handlers);

  const commands = React.useMemo((): readonly PaletteCommand[] => {
    if (!enabled) return NONE;
    const list: PaletteCommand[] = [
      {
        id: 'rows-select-all',
        group: 'page',
        label: t('selectAll'),
        icon: <SquareCheckIcon className={ICON} />,
        keywords: keywordsOf(t('selectAllKeywords')),
        run: () => latest.current.selectAll(),
      },
    ];
    if (aiColumns.length > 0) {
      list.push({
        id: 'database-ai-fill-column',
        group: 'page',
        label: t('aiFillColumn'),
        placeholder: t('aiFillPlaceholder'),
        icon: <SparklesIcon className={ICON} />,
        keywords: keywordsOf(t('aiFillColumnKeywords')),
        searchable: true,
        children: () =>
          aiColumns.map((property) => ({
            id: `database-ai-fill-column-${property.id}`,
            group: 'page',
            label: property.name,
            icon: <SparklesIcon className={ICON} />,
            keywords: [],
            run: () => latest.current.aiFillColumn(property),
          })),
      });
    }
    if (selectedCount === 0) return list;
    const columns: PaletteCommand[] = properties.map((property) => ({
      id: `rows-set-${property.id}`,
      group: 'page',
      label: property.name,
      icon: <PencilLineIcon className={ICON} />,
      keywords: [],
      run: () => latest.current.edit(property),
    }));
    if (columns.length > 0) {
      list.push({
        id: 'rows-set',
        group: 'page',
        label: t('setValue', { count: selectedCount }),
        placeholder: t('setValuePlaceholder'),
        icon: <PencilLineIcon className={ICON} />,
        keywords: keywordsOf(t('setValueKeywords')),
        searchable: true,
        children: () => columns,
      });
    }
    if (aiColumns.length > 0) {
      list.push({
        id: 'rows-ai-fill',
        group: 'page',
        label: t('aiFill', { count: selectedCount }),
        placeholder: t('aiFillPlaceholder'),
        icon: <SparklesIcon className={ICON} />,
        keywords: keywordsOf(t('aiFillKeywords')),
        searchable: true,
        children: () =>
          aiColumns.map((property) => ({
            id: `rows-ai-fill-${property.id}`,
            group: 'page',
            label: property.name,
            icon: <SparklesIcon className={ICON} />,
            keywords: [],
            run: () => latest.current.aiFill(property),
          })),
      });
    }
    list.push(
      {
        id: 'rows-duplicate',
        group: 'page',
        label: t('duplicate', { count: selectedCount }),
        icon: <CopyIcon className={ICON} />,
        keywords: keywordsOf(t('duplicateKeywords')),
        run: () => latest.current.duplicate(),
      },
      {
        id: 'rows-trash',
        group: 'page',
        label: t('trash', { count: selectedCount }),
        icon: <Trash2Icon className={ICON} />,
        keywords: keywordsOf(t('trashKeywords')),
        run: () => latest.current.trash(),
      },
      {
        id: 'rows-clear',
        group: 'page',
        label: t('clear'),
        icon: <SquareIcon className={ICON} />,
        keywords: keywordsOf(t('clearKeywords')),
        run: () => latest.current.clear(),
      },
    );
    return list;
  }, [aiColumns, enabled, latest, properties, selectedCount, t]);

  usePaletteContribution('database-rows', commands);
}
