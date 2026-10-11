'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import {
  amountInDurationUnit,
  describeDuration,
  durationFromAmount,
  type DurationUnit,
  durationUnitsFor,
  preferredDurationUnit,
  withStoredUnit,
} from '@/lib/duration';

/**
 * A duration, entered as an amount and a unit (issue #169).
 *
 * The value stays in the unit it is stored in (`base`); the field converts both
 * ways without rounding (`lib/duration.ts`). An amount that names no whole
 * number of the stored unit, or one outside `min`/`max`, does not reach
 * `onChange`: the field says what is wrong, `onValidityChange` tells the form,
 * and the value keeps the last one that was valid. Changing the unit keeps the
 * number and changes what it means, which is what somebody who typed "7" and
 * then picked days intended.
 */

/** The words for a duration in running text (`7 Tage`), in the reader's language. */
export function useDurationWords(): (value: number, base: DurationUnit) => string {
  const t = useTranslations('ui.durationInput');
  return React.useCallback(
    (value: number, base: DurationUnit) => {
      const { amount, unit } = describeDuration(value, base);
      return t(`amounts.${unit}`, { count: amount });
    },
    [t],
  );
}

type Problem = 'invalid' | 'range' | null;

interface DurationDraft {
  amount: string;
  unit: DurationUnit;
  /** The value this text last stood for; `null` is an empty field. */
  value: number | null;
  problem: Problem;
}

function draftOf(
  value: number | null,
  base: DurationUnit,
  units: readonly DurationUnit[],
): DurationDraft {
  if (value === null) {
    return { amount: '', unit: preferredDurationUnit(0, base, units), value, problem: null };
  }
  const unit = preferredDurationUnit(value, base, units);
  return { amount: amountInDurationUnit(value, base, unit), unit, value, problem: null };
}

export interface DurationInputProps {
  id: string;
  name?: string;
  /** The unit the value is stored in. */
  base: DurationUnit;
  /** In `base`; `null` is an empty field, which only `allowEmpty` accepts. */
  value: number | null;
  onChange: (value: number | null) => void;
  onValidityChange?: (valid: boolean) => void;
  /** Bounds in `base`; a value outside them is refused with the range named. */
  min?: number;
  max?: number;
  /** The units offered; by default the stored one and those that fit under `max`. */
  units?: readonly DurationUnit[];
  allowEmpty?: boolean;
  placeholder?: string;
  /**
   * Whether a refused amount leaves the last valid value in the form. The
   * settings forms work that way and say so; a dialog that refuses to save
   * instead does not need the sentence.
   */
  keepsLastValid?: boolean;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'data-testid'?: string;
}

export function DurationInput({
  id,
  name,
  base,
  value,
  onChange,
  onValidityChange,
  min,
  max,
  units: offered,
  allowEmpty = false,
  placeholder,
  keepsLastValid = false,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid = false,
  'data-testid': testId,
}: DurationInputProps) {
  const t = useTranslations('ui.durationInput');
  const words = useDurationWords();
  const units = withStoredUnit(value ?? 0, base, offered ?? durationUnitsFor(base, max));
  const [draft, setDraft] = React.useState(() => draftOf(value, base, units));
  // A value that changed from outside (a discarded draft, a reload) replaces
  // the text; one this field emitted itself is already what it shows.
  if (draft.value !== value) setDraft(draftOf(value, base, units));
  // The unit the text is in stays on offer even after the value moved on.
  if (!units.includes(draft.unit)) units.unshift(draft.unit);
  const problemId = `${id}-duration-problem`;

  function update(amount: string, unit: DurationUnit): void {
    let next: number | null;
    let problem: Problem = null;
    if (amount.trim().length === 0) {
      next = null;
      if (!allowEmpty) problem = 'invalid';
    } else {
      next = durationFromAmount(amount, unit, base);
      if (next === null) problem = 'invalid';
      else if ((min !== undefined && next < min) || (max !== undefined && next > max)) {
        problem = 'range';
      }
    }
    if (problem !== null) {
      setDraft({ amount, unit, value: draft.value, problem });
    } else {
      setDraft({ amount, unit, value: next, problem: null });
      onChange(next);
    }
    if ((problem === null) !== (draft.problem === null)) onValidityChange?.(problem === null);
  }

  let message: string | null = null;
  if (draft.problem === 'range' && min !== undefined && max !== undefined) {
    message = t('outOfRange', { min: words(min, base), max: words(max, base) });
  } else if (draft.problem !== null) {
    message = t('invalid');
  }
  if (message !== null && keepsLastValid) message = `${message} ${t('keepsLastValid')}`;

  return (
    <>
      <div className="flex gap-2">
        <Input
          id={id}
          name={name}
          // Text rather than number: a number field hands over an empty string
          // for `1,5` in some browsers, and the comma is how half of the
          // readers write a decimal.
          type="text"
          inputMode="decimal"
          autoComplete="off"
          className="min-w-0 flex-1"
          value={draft.amount}
          placeholder={placeholder}
          aria-invalid={ariaInvalid || draft.problem !== null}
          aria-describedby={
            [describedBy, message === null ? undefined : problemId]
              .filter((part) => part !== undefined)
              .join(' ') || undefined
          }
          data-testid={testId}
          onChange={(event) => update(event.target.value, draft.unit)}
        />
        <Select
          value={draft.unit}
          onValueChange={(next) => {
            const unit = units.find((candidate) => candidate === next);
            if (unit !== undefined) update(draft.amount, unit);
          }}
        >
          <SelectTrigger
            className="w-32 shrink-0"
            aria-label={t('unit')}
            data-testid={`${id}-unit`}
          >
            <SelectValue>{() => t(`units.${draft.unit}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {units.map((unit) => (
              <SelectItem key={unit} value={unit}>
                {t(`units.${unit}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {message === null ? null : (
        <p id={problemId} className="text-xs text-destructive-text" data-testid={problemId}>
          {message}
        </p>
      )}
    </>
  );
}

/** What `DurationTextInput` hands over while its field holds an amount it cannot save. */
export const INVALID_DURATION_TEXT = 'invalid';

/**
 * `DurationInput` for a form whose draft keeps numbers as text, the way the
 * eval and automation dialogs do. The text is the count in `base` (`"600"`),
 * empty for none, or `INVALID_DURATION_TEXT` while the field is refusing what
 * was typed: every whole-number check those drafts already run then refuses
 * it too, so a half-typed amount can never be saved as "no limit".
 */
export function DurationTextInput({
  value,
  onChange,
  ...props
}: Omit<DurationInputProps, 'value' | 'onChange' | 'onValidityChange'> & {
  value: string;
  onChange: (text: string) => void;
}) {
  const parsed = /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
  // While the draft says "invalid", the field keeps showing what was typed,
  // which needs the value it last emitted rather than an empty one.
  const [lastValid, setLastValid] = React.useState(parsed);
  if (value !== INVALID_DURATION_TEXT && parsed !== lastValid) setLastValid(parsed);
  return (
    <DurationInput
      {...props}
      value={value === INVALID_DURATION_TEXT ? lastValid : parsed}
      onChange={(next) => onChange(next === null ? '' : String(next))}
      onValidityChange={(valid) => {
        if (!valid) onChange(INVALID_DURATION_TEXT);
      }}
    />
  );
}
