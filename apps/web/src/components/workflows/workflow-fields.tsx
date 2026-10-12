'use client';

import * as React from 'react';

import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { MoneyInput } from '@/components/money-input';
import { BUDGET_MAX_MICRO_USD } from '@/lib/money';

/**
 * The few field shapes the workflow panels are made of (issue #164): a
 * label above its control and a hint below it, as in every other form here.
 * Numbers keep the text being typed until it parses, so "0," on the way to
 * "0,25" is not thrown away.
 */

export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A choice from a short closed list; the value `''` stands for "none". */
export function ChoiceField<T extends string>({
  id,
  label,
  hint,
  value,
  options,
  onChange,
  testId,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  testId?: string;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <Field id={id} label={label} hint={hint}>
      <Select value={value} onValueChange={(next) => onChange(String(next) as T)}>
        <SelectTrigger id={id} data-testid={testId}>
          <SelectValue>{() => current?.label ?? value}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Reads a number the way a person types it here: a comma is a decimal point. */
export function parseNumber(text: string): number | null {
  const normalised = text.trim().replace(',', '.');
  if (normalised.length === 0) return null;
  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

/**
 * A nullable number. Empty means "no value of its own" (null), which for
 * every limit here means "inherit", and the field says so in its placeholder.
 */
export function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  scale = 1,
  integer = true,
  min,
  testId,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
  /** Shown as `value / scale`: micro-dollars as dollars, seconds as hours. */
  scale?: number;
  /** Whether the stored value is an integer (after scaling back). */
  integer?: boolean;
  min?: number;
  testId?: string;
}) {
  const shown = value === null ? '' : String(value / scale);
  const [text, setText] = React.useState(shown);
  const [lastShown, setLastShown] = React.useState(shown);
  // A value changed from outside (another node chosen, a reload) replaces
  // what is typed; one that only round-trips what was typed does not.
  if (shown !== lastShown) {
    setLastShown(shown);
    const typed = parseNumber(text);
    if (typed === null ? value !== null : typed * scale !== value) setText(shown);
  }
  const parsed = parseNumber(text);
  const invalid =
    text.trim().length > 0 && (parsed === null || (min !== undefined && parsed * scale < min));
  return (
    <Field id={id} label={label} hint={hint}>
      <Input
        id={id}
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        aria-invalid={invalid}
        data-testid={testId}
        className="max-w-40"
        onChange={(event) => {
          setText(event.target.value);
          const next = parseNumber(event.target.value);
          if (event.target.value.trim().length === 0) onChange(null);
          else if (next !== null) {
            const stored = integer ? Math.round(next * scale) : next * scale;
            if (min === undefined || stored >= min) onChange(stored);
          }
        }}
      />
    </Field>
  );
}

/**
 * A nullable amount of money, stored in micro-dollars and shown in dollars
 * (issue #167). Empty means "inherit", like every other limit here; an amount
 * the field refuses keeps the last valid value and says so.
 */
export function MoneyField({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  testId,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <Field id={id} label={label} hint={hint}>
      <MoneyInput
        id={id}
        value={value}
        min={0}
        max={BUDGET_MAX_MICRO_USD}
        allowEmpty
        keepsLastValid
        placeholder={placeholder}
        className="max-w-40"
        data-testid={testId}
        onChange={onChange}
      />
    </Field>
  );
}
