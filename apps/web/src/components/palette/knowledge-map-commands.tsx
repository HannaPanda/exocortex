'use client';

import { MonitorPlayIcon, PaletteIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { useLatest, usePaletteContribution } from './contributions';
import { keywordsOf, type PaletteCommand } from './palette-command';

const ICON = 'size-4 text-muted-foreground';

/**
 * What the palette offers on the knowledge map (issue #189): opening the
 * panel that tunes how the map looks, and starting the screensaver. Listed
 * only while the map is open, because both live there and nowhere else.
 */
export function useKnowledgeMapCommands({
  onAppearance,
  onScreensaver,
}: {
  onAppearance: () => void;
  onScreensaver: () => void;
}): void {
  const t = useTranslations('shell.paletteCommands.knowledgeMap');
  const latest = useLatest({ onAppearance, onScreensaver });
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
      {
        id: 'knowledge-map-screensaver',
        group: 'view',
        label: t('screensaver'),
        icon: <MonitorPlayIcon className={ICON} />,
        keywords: keywordsOf(t('screensaverKeywords')),
        run: () => latest.current.onScreensaver(),
      },
    ],
    [t, latest],
  );
  usePaletteContribution('knowledge-map', commands);
}
