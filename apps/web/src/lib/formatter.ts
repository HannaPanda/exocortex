'use client';

import { type DateTimeFormatOptions, useFormatter as useIntlFormatter } from 'next-intl';
import * as React from 'react';

import { useHourCycle, withHourCycle } from '@exocortex/ui';

type IntlFormatter = ReturnType<typeof useIntlFormatter>;

/**
 * Formats like next-intl's `useFormatter`, on the reader's clock (issue
 * #255).
 *
 * A time of day (`timeStyle`, or an `hour`) gets the account's 24- or 12-hour
 * clock when it chose one, and the interface language's clock otherwise,
 * which is what `Intl` does by itself. A date without a time is untouched:
 * it has no clock. The zone stays next-intl's (the reader's, ADR-062), and a
 * caller that names `timeZone: 'UTC'` for a whole day keeps it.
 *
 * Only the option-object form is offered: there are no named formats in this
 * application, and the object is what the clock is added to.
 */
export interface Formatter extends Omit<IntlFormatter, 'dateTime' | 'dateTimeRange'> {
  dateTime: (value: Date | number, options?: DateTimeFormatOptions) => string;
  dateTimeRange: (
    start: Date | number,
    end: Date | number,
    options?: DateTimeFormatOptions,
  ) => string;
}

export function useFormatter(): Formatter {
  const format = useIntlFormatter();
  const cycle = useHourCycle();
  return React.useMemo(
    () => ({
      ...format,
      dateTime: (value, options) =>
        format.dateTime(value, options === undefined ? undefined : withHourCycle(options, cycle)),
      dateTimeRange: (start, end, options) =>
        format.dateTimeRange(
          start,
          end,
          options === undefined ? undefined : withHourCycle(options, cycle),
        ),
    }),
    [format, cycle],
  );
}
