'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import * as React from 'react';

import { Input } from '@exocortex/ui';

import { formatMicroUsd, microUsdFromText, usdInputText } from '@/lib/money';

/**
 * An amount of money, entered in US dollars (issue #167).
 *
 * The value stays in micro-dollars, the integer the API stores; the field
 * shows and reads dollars, exactly and in the reader's way (`2,00`), with
 * `lib/money.ts` converting both ways. An amount that names no whole number of
 * micro-dollars, or one outside `min`/`max`, does not reach `onChange`: the
 * field says what is wrong, `onValidityChange` tells the form, and the value
 * keeps the last one that was valid. An empty field is `null`, which only
 * `allowEmpty` accepts, and `0` is a value of its own, never the same as empty.
 */

type Problem = 'invalid' | 'range' | null;

interface MoneyDraft {
  text: string;
  /** The value this text last stood for; `null` is an empty field. */
  value: number | null;
  problem: Problem;
}

export interface MoneyInputProps {
  id: string;
  name?: string;
  /** In micro-dollars; `null` is an empty field. */
  value: number | null;
  onChange: (value: number | null) => void;
  onValidityChange?: (valid: boolean) => void;
  /** Bounds in micro-dollars; a value outside them is refused with the range named. */
  min?: number;
  max?: number;
  allowEmpty?: boolean;
  placeholder?: string;
  /** Whether a refused amount leaves the last valid value in the form, and the field says so. */
  keepsLastValid?: boolean;
  className?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'data-testid'?: string;
}

export function MoneyInput({
  id,
  name,
  value,
  onChange,
  onValidityChange,
  min,
  max,
  allowEmpty = false,
  placeholder,
  keepsLastValid = false,
  className,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid = false,
  'data-testid': testId,
}: MoneyInputProps) {
  const t = useTranslations('ui.moneyInput');
  const format = useFormatter();
  const locale = useLocale();
  const draftOf = (next: number | null): MoneyDraft => ({
    text: next === null ? '' : usdInputText(next, locale),
    value: next,
    problem: null,
  });
  const [draft, setDraft] = React.useState(() => draftOf(value));
  // A value that changed from outside (a discarded draft, a reload) replaces
  // the text; one this field emitted itself is already what it shows.
  if (draft.value !== value) setDraft(draftOf(value));
  const problemId = `${id}-money-problem`;

  function update(text: string): void {
    let next: number | null;
    let problem: Problem = null;
    if (text.trim().length === 0) {
      next = null;
      if (!allowEmpty) problem = 'invalid';
    } else {
      next = microUsdFromText(text);
      if (next === null) problem = 'invalid';
      else if ((min !== undefined && next < min) || (max !== undefined && next > max)) {
        problem = 'range';
      }
    }
    if (problem !== null) {
      setDraft({ text, value: draft.value, problem });
    } else {
      setDraft({ text, value: next, problem: null });
      onChange(next);
    }
    if ((problem === null) !== (draft.problem === null)) onValidityChange?.(problem === null);
  }

  let message: string | null = null;
  if (draft.problem === 'range' && min !== undefined && max !== undefined) {
    message = t('outOfRange', {
      min: formatMicroUsd(format, min),
      max: formatMicroUsd(format, max),
    });
  } else if (draft.problem !== null) {
    message = t('invalid');
  }
  if (message !== null && keepsLastValid) message = `${message} ${t('keepsLastValid')}`;

  return (
    <>
      <Input
        id={id}
        name={name}
        // Text rather than number: a number field hands over an empty string
        // for `2,50` in some browsers, and the comma is how half of the
        // readers write cents.
        type="text"
        inputMode="decimal"
        autoComplete="off"
        className={className}
        value={draft.text}
        placeholder={placeholder}
        aria-invalid={ariaInvalid || draft.problem !== null}
        aria-describedby={
          [describedBy, message === null ? undefined : problemId]
            .filter((part) => part !== undefined)
            .join(' ') || undefined
        }
        data-testid={testId}
        onChange={(event) => update(event.target.value)}
      />
      {message === null ? null : (
        <p id={problemId} className="text-xs text-destructive-text" data-testid={problemId}>
          {message}
        </p>
      )}
    </>
  );
}

/** What `MoneyTextInput` hands over while its field holds an amount it cannot save. */
export const INVALID_MONEY_TEXT = 'invalid';

/**
 * `MoneyInput` for a form whose draft keeps numbers as text, the way the
 * dialogs for profiles, work items and evals do. The text is the count of
 * micro-dollars (`"2000000"`), empty for none, or `INVALID_MONEY_TEXT` while
 * the field is refusing what was typed, which `microUsdOfDraft` refuses too, so
 * a half-typed amount can never be saved as "no limit".
 */
export function MoneyTextInput({
  value,
  onChange,
  ...props
}: Omit<MoneyInputProps, 'value' | 'onChange' | 'onValidityChange'> & {
  value: string;
  onChange: (text: string) => void;
}) {
  const parsed = /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
  // While the draft says "invalid", the field keeps showing what was typed,
  // which needs the value it last emitted rather than an empty one.
  const [lastValid, setLastValid] = React.useState(parsed);
  if (value !== INVALID_MONEY_TEXT && parsed !== lastValid) setLastValid(parsed);
  return (
    <MoneyInput
      {...props}
      value={value === INVALID_MONEY_TEXT ? lastValid : parsed}
      onChange={(next) => onChange(next === null ? '' : String(next))}
      onValidityChange={(valid) => {
        if (!valid) onChange(INVALID_MONEY_TEXT);
      }}
    />
  );
}
