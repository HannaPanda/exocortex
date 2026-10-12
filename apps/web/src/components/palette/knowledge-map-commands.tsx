'use client';

import { PaletteIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { useLatest, usePaletteContribution } from './contributions';
import { keywordsOf, type PaletteCommand } from './palette-command';

const ICON = 'size-4 text-muted-foreground';

/**
 * What the palette offers on the knowledge map (issue #189): opening the
 * panel that tunes how the map looks. Listed only while the map is open,
 * because the panel lives there and nowhere else.
 */
export function useKnowledgeMapCommands({ onAppearance }: { onAppearance: () => void }): void {
  const t = useTranslations('shell.paletteCommands.knowledgeMap');
  const latest = useLatest({ onAppearance });
  const commands = React.useMemo<readonly PaletteCommand[]>(
    () => [
      {
        id: 'knowledge-map-appearance',
        group: 'view',
        label: t('appearance'),
        icon: <PaletteIcon className={ICON} />,
        keywords: keywordsOf(t('appearanceKeywords')),
        run: () => latest.current.onAppearance(),
      },
    ],
    [t, latest],
  );
  usePaletteContribution('knowledge-map', commands);
}
