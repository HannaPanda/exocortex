'use client';

import { ClockIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import * as React from 'react';

import { TIME_FORMATS } from '@exocortex/contracts';
import { formatTimeOfDay, hourCycleOf } from '@exocortex/ui';

import { useTimeFormatPreference } from '@/lib/api/preferences-queries';

import { useLatest } from './contributions';
import { keywordsOf, type PaletteCommand } from './palette-command';

/**
 * Choosing the clock every time is written on (issue #255): one command for
 * each clock the account is not on, named with its own example, so "12
 * Stunden (2:30 PM)" says what the press will do. Offered everywhere, because
 * the choice is the person's and not the open page's.
 */
export function useTimeFormatCommands(): PaletteCommand[] {
  const t = useTranslations('shell.paletteCommands.timeFormat');
  const locale = useLocale();
  const preference = useTimeFormatPreference();
  const latest = useLatest(preference);
  const current = preference.format;

  return React.useMemo(
    () =>
      TIME_FORMATS.filter((format) => format !== current).map((format) => {
        const example = formatTimeOfDay('14:30', locale, hourCycleOf(format));
        return {
          id: `command-time-format-${format}`,
          group: 'settings' as const,
          label:
            format === 'auto'
              ? t('auto', { example })
              : format === '24h'
                ? t('h24', { example })
                : t('h12', { example }),
          hint: t('hint'),
          icon: <ClockIcon className="size-4 text-muted-foreground" />,
          keywords: keywordsOf(t('keywords')),
          run: () => latest.current.change(format),
        };
      }),
    [current, locale, t, latest],
  );
}
