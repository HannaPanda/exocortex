'use client';

import { ExternalLinkIcon, PanelRightCloseIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { useLatest, usePaletteContribution } from './contributions';
import { keywordsOf, type PaletteCommand } from './palette-command';

const ICON = 'size-4 text-muted-foreground';
const NONE: readonly PaletteCommand[] = [];

/**
 * What the palette offers while a row is open beside its database (issue
 * #239): closing the side panel, and opening the row as the whole page.
 */
export function useRowPeekCommands({
  open,
  pageHref,
  close,
}: {
  open: boolean;
  pageHref: string | null;
  close: () => void;
}): void {
  const t = useTranslations('shell.paletteCommands.rowPeek');
  const latest = useLatest(close);

  const commands = React.useMemo((): readonly PaletteCommand[] => {
    if (!open || pageHref === null) return NONE;
    return [
      {
        id: 'row-peek-open-page',
        group: 'page',
        label: t('openAsPage'),
        icon: <ExternalLinkIcon className={ICON} />,
        keywords: keywordsOf(t('openAsPageKeywords')),
        href: pageHref,
      },
      {
        id: 'row-peek-close',
        group: 'page',
        label: t('close'),
        hint: 'Esc',
        icon: <PanelRightCloseIcon className={ICON} />,
        keywords: keywordsOf(t('closeKeywords')),
        run: () => latest.current(),
      },
    ];
  }, [latest, open, pageHref, t]);

  usePaletteContribution('row-peek', commands);
}
