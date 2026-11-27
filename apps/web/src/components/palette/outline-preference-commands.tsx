'use client';

import { Columns2Icon, LayersIcon, MousePointerClickIcon, PointerIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { useOutlinePreferences } from '@/lib/api/preferences-queries';

import { useLatest } from './contributions';
import { keywordsOf, type PaletteCommand } from './palette-command';

const ICON = 'size-4 text-muted-foreground';

/**
 * Switching where a pinned page outline sits (issue #283): in a column of its
 * own with the text moved aside, or over the text.
 *
 * One command named by what the press does, like the chat's scrolling:
 * "über dem Text liegen" while the text moves aside, "Text ausweichen
 * lassen" while the list lies over it. Offered everywhere, because the
 * choice is the person's and not the open page's. Opening the scale on hover
 * is a toggle of the same kind. The transparency and stepping aside are
 * finer choices and live on the settings page the palette also opens.
 */
export function useOutlinePreferenceCommands(): PaletteCommand[] {
  const t = useTranslations('shell.paletteCommands.outlinePinned');
  const tHover = useTranslations('shell.paletteCommands.outlineHoverExpand');
  const preferences = useOutlinePreferences();
  const latest = useLatest(preferences);
  const pinned = preferences.pinned;
  const hoverExpand = preferences.hoverExpand;

  return React.useMemo(() => {
    const next = pinned === 'column' ? 'overlay' : 'column';
    return [
      {
        id: 'command-outline-pinned',
        group: 'settings',
        label: next === 'overlay' ? t('overlay') : t('column'),
        hint: t('hint'),
        icon:
          next === 'overlay' ? <LayersIcon className={ICON} /> : <Columns2Icon className={ICON} />,
        keywords: keywordsOf(t('keywords')),
        run: () => latest.current.change({ outlinePinned: next }),
      },
      {
        id: 'command-outline-hover-expand',
        group: 'settings',
        label: hoverExpand ? tHover('off') : tHover('on'),
        hint: tHover('hint'),
        icon: hoverExpand ? (
          <MousePointerClickIcon className={ICON} />
        ) : (
          <PointerIcon className={ICON} />
        ),
        keywords: keywordsOf(tHover('keywords')),
        run: () => latest.current.change({ outlineHoverExpand: !hoverExpand }),
      },
    ];
  }, [pinned, hoverExpand, t, tHover, latest]);
}
