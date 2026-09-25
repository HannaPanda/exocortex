'use client';

import { EyeIcon, LayoutListIcon, PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DatabaseView, type DatabaseViewType } from '@exocortex/contracts';

import { useCreateDatabaseRow, useCreateDatabaseView } from '@/lib/api/database-queries';

import { useLatest, usePaletteContribution } from './contributions';
import { keywordsOf, type PaletteCommand } from './palette-command';

const ICON = 'size-4 text-muted-foreground';
const VIEW_TYPES: readonly DatabaseViewType[] = ['TABLE', 'BOARD', 'GALLERY', 'CALENDAR'];
const NONE: readonly PaletteCommand[] = [];

/**
 * What the palette offers on an open database (issue #148): a new row, a new
 * view of each kind, and every other view by its name.
 *
 * Only for the database that is the page. An embedded one is a block inside
 * somebody's text, and a page with three of them would offer three "Neue
 * Zeile" nobody could tell apart.
 */
export function useDatabaseCommands({
  documentId,
  views,
  activeViewId,
  onSelectView,
  readOnly,
  enabled,
}: {
  documentId: string;
  views: readonly DatabaseView[] | undefined;
  activeViewId: string | null;
  onSelectView: (viewId: string) => void;
  readOnly: boolean;
  enabled: boolean;
}): void {
  const t = useTranslations('shell.paletteCommands.database');
  const tViewTypes = useTranslations('database.viewTypes');
  const tRows = useTranslations('database.rows');
  const createRow = useCreateDatabaseRow(documentId);
  const createView = useCreateDatabaseView(documentId);
  const latest = useLatest({ createRow, createView, onSelectView });

  const commands = React.useMemo(() => {
    if (!enabled || views === undefined) return NONE;
    const list: PaletteCommand[] = views
      .filter((view) => view.id !== activeViewId)
      .map((view) => ({
        id: `database-view-${view.id}`,
        group: 'page',
        label: t('showView', { name: view.name }),
        icon: <EyeIcon className={ICON} />,
        keywords: keywordsOf(t('showViewKeywords')),
        run: () => latest.current.onSelectView(view.id),
      }));
    if (readOnly) return list;

    list.unshift({
      id: 'database-new-row',
      group: 'create',
      label: t('newRow'),
      icon: <PlusIcon className={ICON} />,
      keywords: keywordsOf(t('newRowKeywords')),
      run: () => latest.current.createRow.mutate({ title: tRows('untitled'), values: [] }),
    });
    for (const type of VIEW_TYPES) {
      list.push({
        id: `database-new-view-${type}`,
        group: 'create',
        label: t('newView', { type: tViewTypes(type) }),
        icon: <LayoutListIcon className={ICON} />,
        keywords: keywordsOf(t('newViewKeywords')),
        run: () => {
          void latest.current.createView
            .mutateAsync({ type, name: tViewTypes(type) })
            .then((view) => latest.current.onSelectView(view.id));
        },
      });
    }
    return list;
  }, [activeViewId, enabled, latest, readOnly, t, tRows, tViewTypes, views]);

  usePaletteContribution('database', commands);
}
