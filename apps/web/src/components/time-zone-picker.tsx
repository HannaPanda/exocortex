'use client';

import { useLocale, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  canonicalTimeZone,
  findTimeZoneOption,
  matchesTimeZoneQuery,
  supportedTimeZones,
  type TimeZoneOption,
  timeZoneOption,
  timeZoneOptions,
} from '@exocortex/i18n';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  Input,
} from '@exocortex/ui';

/**
 * The one way an IANA zone is entered (issue #172): a searchable list instead
 * of guessing how `Europe/Berlin` is spelled.
 *
 * The value stays the id a person or an agent stored. A spelling the runtime
 * lists differently (`Europe/Kyiv` beside `Europe/Kiev`) is shown as its own
 * row and kept, never swapped for the listed one; an id no runtime knows is
 * marked invalid and left in place until somebody picks another, because a
 * field that quietly rewrites a stored value has changed a rule nobody asked
 * it to change. The browser's own zone comes first as the likely answer.
 *
 * A runtime without `Intl.supportedValuesOf` has no list to offer, so it keeps
 * the plain text field the API has always validated.
 */

/** The listed zones per reader language, built once: about 420 formatter pairs. */
const BASE_OPTIONS = new Map<string, TimeZoneOption[]>();

function baseOptions(locale: string, at: Date): TimeZoneOption[] {
  let options = BASE_OPTIONS.get(locale);
  if (options === undefined) {
    options = timeZoneOptions(supportedTimeZones(), locale, at);
    BASE_OPTIONS.set(locale, options);
  }
  return options;
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
}

export function TimeZonePicker({
  id,
  value,
  onChange,
  className,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  'aria-invalid': invalid = false,
  'data-testid': testId,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  /** Only where no `<Label htmlFor={id}>` names the field. */
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'data-testid'?: string;
}) {
  const t = useTranslations('ui.timeZonePicker');
  const locale = useLocale();
  const [listed] = React.useState(() => supportedTimeZones().length > 0);
  const [own] = React.useState(browserZone);
  const selectOnClick = React.useRef(false);

  const options = React.useMemo(() => {
    if (!listed) return [];
    const at = new Date();
    const base = baseOptions(locale, at);
    const extras = [value, own]
      .filter((extra) => extra !== '' && !base.some((option) => option.id === extra))
      .map((extra) => timeZoneOption(extra, locale, at))
      .filter((option) => option !== null);
    const all = [...base, ...extras];
    // The browser's zone first: for most people it is the answer.
    const mine = findTimeZoneOption(all, own);
    return mine === undefined ? all : [mine, ...all.filter((option) => option !== mine)];
  }, [listed, locale, value, own]);

  const selected = value === '' ? null : (options.find((option) => option.id === value) ?? null);
  const unknown = value !== '' && canonicalTimeZone(value) === null;
  const unknownId = `${id}-unknown`;
  const describedByAll =
    [describedBy, unknown ? unknownId : null].filter(Boolean).join(' ') || undefined;

  if (!listed) {
    return (
      <Input
        id={id}
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(event.target.value.trim())}
        placeholder="Europe/Berlin"
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid || unknown}
        className={className}
      />
    );
  }

  return (
    <div className={className}>
      <Combobox
        items={options}
        value={selected}
        onValueChange={(option: TimeZoneOption | null) => {
          if (option !== null) onChange(option.id);
        }}
        itemToStringLabel={(option: TimeZoneOption) => option.id}
        isItemEqualToValue={(left: TimeZoneOption, right: TimeZoneOption) => left.id === right.id}
        filter={(option: TimeZoneOption, query: string) => matchesTimeZoneQuery(option, query)}
      >
        <ComboboxInput
          id={id}
          data-testid={testId}
          placeholder={unknown ? value : t('placeholder')}
          autoComplete="off"
          spellCheck={false}
          aria-label={ariaLabel}
          aria-describedby={describedByAll}
          aria-invalid={invalid || unknown}
          // The first click into a filled field selects its id, so typing
          // searches instead of appending to `Europe/Berlin`.
          onFocus={() => {
            selectOnClick.current = true;
          }}
          onClick={(event) => {
            if (!selectOnClick.current) return;
            selectOnClick.current = false;
            event.currentTarget.select();
          }}
        />
        <ComboboxContent>
          <ComboboxEmpty>{t('empty')}</ComboboxEmpty>
          <ComboboxList>
            {(option: TimeZoneOption) => (
              <ComboboxItem key={option.id} value={option}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate font-medium">{option.place}</span>
                    {option.id === own ? (
                      <span className="text-xs text-muted-foreground">{t('thisDevice')}</span>
                    ) : null}
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                      {option.offset}
                    </span>
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {option.canonical === option.id
                      ? [option.id, option.name].filter(Boolean).join(' · ')
                      : t('alias', { id: option.id, zone: option.canonical })}
                  </span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {unknown ? (
        <p id={unknownId} className="mt-1.5 text-xs text-destructive-text">
          {t('unknown', { id: value })}
        </p>
      ) : null}
    </div>
  );
}
