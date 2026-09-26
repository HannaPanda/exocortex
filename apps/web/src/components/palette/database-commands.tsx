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
 * What the palette offers on an open database (issue #148): a new row,
 * "Neue Ansicht → Board", and "Ansicht wechseln → <name>".
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
    const list: PaletteCommand[] = [];
    // Two questions, each with its answers: which view, and which kind of new
    // one. Both searchable, so a view's name alone finds it.
    const others: PaletteCommand[] = views
      .filter((view) => view.id !== activeViewId)
      .map((view) => ({
        id: `database-view-${view.id}`,
        group: 'page',
        label: view.name,
        icon: <EyeIcon className={ICON} />,
        keywords: keywordsOf(t('showViewKeywords')),
        run: () => latest.current.onSelectView(view.id),
      }));
    if (others.length > 0) {
      list.push({
        id: 'database-view',
        group: 'page',
        label: t('showView'),
        placeholder: t('showViewPlaceholder'),
        icon: <EyeIcon className={ICON} />,
        keywords: keywordsOf(t('showViewKeywords')),
        searchable: true,
        children: () => others,
      });
    }
    if (readOnly) return list;

    const kinds: PaletteCommand[] = VIEW_TYPES.map((type) => ({
      id: `database-new-view-${type}`,
      group: 'create',
      label: tViewTypes(type),
      icon: <LayoutListIcon className={ICON} />,
      keywords: keywordsOf(t('newViewKeywords')),
      run: () => {
        void latest.current.createView
          .mutateAsync({ type, name: tViewTypes(type) })
          .then((view) => latest.current.onSelectView(view.id));
      },
    }));
    list.push(
      {
        id: 'database-new-row',
        group: 'create',
        label: t('newRow'),
        icon: <PlusIcon className={ICON} />,
        keywords: keywordsOf(t('newRowKeywords')),
        run: () => latest.current.createRow.mutate({ title: tRows('untitled'), values: [] }),
      },
      {
        id: 'database-new-view',
        group: 'create',
        label: t('newView'),
        placeholder: t('newViewPlaceholder'),
        icon: <LayoutListIcon className={ICON} />,
        keywords: keywordsOf(t('newViewKeywords')),
        searchable: true,
        children: () => kinds,
      },
    );
    return list;
  }, [activeViewId, enabled, latest, readOnly, t, tRows, tViewTypes, views]);

  usePaletteContribution('database', commands);
}
