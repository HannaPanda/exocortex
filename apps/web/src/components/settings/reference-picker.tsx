'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@exocortex/ui';

import {
  matchesReferenceQuery,
  type ReferenceOption,
  withStoredValue,
} from '@/lib/setting-references';

/**
 * A searchable list for a setting that names something by id: a model, a
 * database (issue #171).
 *
 * The caller decides what fits the field, so the vector model's list only
 * ever holds the embedding models measured against the column, and a chat
 * model's list the registry rows. What this adds is the part every such field
 * shares: search over name and second line, an explicit row for what an
 * empty value means ("Standardmodell", "keine Bilderzeugung"), and a stored
 * value that is no longer offered, which stays selected and says so instead
 * of quietly reading as the automatic choice.
 */

export function ReferencePicker({
  id,
  name,
  value,
  options,
  loading = false,
  onChange,
  described,
  placeholder,
  notListedLabel,
  missingMessage,
  'data-testid': testId,
}: {
  id: string;
  name: string;
  value: string | null;
  options: readonly ReferenceOption[];
  loading?: boolean;
  onChange: (value: string | null) => void;
  described: { 'aria-describedby': string; 'aria-invalid': boolean };
  /** The three texts default to a model's; a database field names its own. */
  placeholder?: string;
  notListedLabel?: string;
  /** `undefined` says nothing yet, while the list is still on its way. */
  missingMessage?: string;
  'data-testid'?: string;
}) {
  const t = useTranslations('settings.row.modelPicker');
  const selectOnClick = React.useRef(false);
  const listed = withStoredValue(options, value, notListedLabel ?? t('notListed'));
  const missingText = loading ? undefined : (missingMessage ?? t('missing', { slug: value ?? '' }));
  const showMissing = listed.missing && missingText !== undefined;
  const selected = listed.options.find((option) => option.value === value) ?? null;
  const missingId = `${id}-missing`;

  return (
    <div>
      <Combobox
        items={listed.options}
        value={selected}
        onValueChange={(option: ReferenceOption | null) => {
          if (option !== null) onChange(option.value);
        }}
        itemToStringLabel={(option: ReferenceOption) => option.label}
        isItemEqualToValue={(left: ReferenceOption, right: ReferenceOption) =>
          left.value === right.value
        }
        filter={(option: ReferenceOption, query: string) => matchesReferenceQuery(option, query)}
      >
        <ComboboxInput
          id={id}
          name={name}
          data-testid={testId}
          placeholder={placeholder ?? t('placeholder')}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={
            showMissing
              ? `${described['aria-describedby']} ${missingId}`
              : described['aria-describedby']
          }
          aria-invalid={described['aria-invalid']}
          // As in the time zone picker: the first click selects the name, so
          // typing searches instead of appending to it.
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
          <ComboboxEmpty>{loading ? t('loading') : t('empty')}</ComboboxEmpty>
          <ComboboxList>
            {(option: ReferenceOption) => (
              <ComboboxItem key={option.value ?? ''} value={option}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{option.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{option.detail}</span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {showMissing ? (
        <p
          id={missingId}
          className="mt-1.5 text-xs text-destructive-text"
          data-testid={`${id}-missing`}
        >
          {missingText}
        </p>
      ) : null}
    </div>
  );
}
