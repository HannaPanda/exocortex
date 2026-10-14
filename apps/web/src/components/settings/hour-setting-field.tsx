'use client';

import { useFormatter } from 'next-intl';

import type { SettingKey, Settings } from '@exocortex/contracts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@exocortex/ui';

/**
 * An hour of the day (0 to 23), picked as a time (issue #169). The stored
 * value has no minutes, so the list offers whole hours and promises no more.
 * The times are written the reader's way (`09:00`, `9:00 AM`), read in UTC so
 * the browser's own zone cannot shift the label away from the stored hour.
 */
export function HourSettingField({
  value,
  onChange,
  described,
  id,
}: {
  value: number;
  onChange: (value: Settings[SettingKey]) => void;
  described: { 'aria-describedby': string; 'aria-invalid': boolean };
  id: string;
}) {
  const format = useFormatter();
  const label = (hour: number): string =>
    format.dateTime(new Date(Date.UTC(2000, 0, 1, hour)), {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    });
  return (
    <Select
      value={String(value)}
      onValueChange={(next) => {
        const hour = Number(next);
        if (Number.isInteger(hour)) onChange(hour);
      }}
    >
      <SelectTrigger id={id} className="w-full sm:w-40" {...described}>
        <SelectValue>{() => label(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {Array.from({ length: 24 }, (_, hour) => (
          <SelectItem key={hour} value={String(hour)}>
            {label(hour)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
