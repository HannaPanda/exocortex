'use client';

import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import * as React from 'react';

import { TIME_FORMATS, type TimeFormat } from '@exocortex/contracts';
import {
  formatTimeOfDay,
  hourCycleOf,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useTimeFormatPreference } from '@/lib/api/preferences-queries';

function isTimeFormat(value: unknown): value is TimeFormat {
  return typeof value === 'string' && (TIME_FORMATS as readonly string[]).includes(value);
}

/** Half past two in the afternoon: a time where the two clocks differ. */
const SAMPLE = '14:30';

/**
 * The clock every time of day is written on for this account (issue #255).
 *
 * Each option carries its own example in the interface language, so the
 * choice is read rather than imagined: "Wie die Sprache (14:30)" says what
 * `auto` means today, and changes its example when the language changes.
 * The zone is named underneath, because "which clock" and "which zone" are
 * the two questions a wrong-looking time raises, and the zone is the device's.
 */
export function TimeFormatField({ onFailed }: { onFailed: () => void }) {
  const t = useTranslations('settings.language');
  const locale = useLocale();
  const timeZone = useTimeZone();
  const preference = useTimeFormatPreference();

  const labelOf = (format: TimeFormat) => {
    const example = formatTimeOfDay(SAMPLE, locale, hourCycleOf(format));
    if (format === 'auto') return t('timeFormatAuto', { example });
    return format === '24h' ? t('timeFormat24h', { example }) : t('timeFormat12h', { example });
  };

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="time-format">{t('timeFormatLegend')}</Label>
      <Select
        value={preference.format}
        disabled={preference.pending}
        onValueChange={(value) => {
          if (isTimeFormat(value)) preference.change(value, { onError: onFailed });
        }}
      >
        <SelectTrigger id="time-format" className="w-full sm:w-72" data-testid="time-format">
          <SelectValue>{() => labelOf(preference.format)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {TIME_FORMATS.map((format) => (
            <SelectItem key={format} value={format}>
              {labelOf(format)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="max-w-measure text-xs text-muted-foreground">
        {t('timeFormatHint', { zone: timeZone ?? '' })}
      </p>
    </div>
  );
}
