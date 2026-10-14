'use client';

import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AiModel,
  SETTING_KEYS,
  SETTING_NUMBER_RANGES,
  SETTING_ZERO_MEANS,
  type SettingKey,
  type SettingNumberRange,
  type Settings,
} from '@exocortex/contracts';
import {
  cn,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@exocortex/ui';

import { ProviderRoutingEditor } from '@/components/ai/provider-routing-editor';
import { DurationInput, useDurationWords } from '@/components/duration-input';
import { MoneyInput } from '@/components/money-input';
import { EntityDatabaseField } from '@/components/settings/entity-database-field';
import { FractionSettingField } from '@/components/settings/fraction-setting-field';
import { HourSettingField } from '@/components/settings/hour-setting-field';
import { ModelSettingField } from '@/components/settings/model-setting-field';
import { useSettingCopy } from '@/components/settings/setting-copy';
import { TextSettingField } from '@/components/settings/text-setting-field';
import { ZeroMeansSettingField } from '@/components/settings/zero-means-setting-field';
import {
  amountInUnit,
  BYTE_UNITS,
  bytesFromAmount,
  type ByteUnit,
  describeBytes,
  isByteSettingKey,
  preferredByteUnit,
} from '@/lib/byte-size';
import { durationBaseOfSettingKey, isHourOfDaySettingKey } from '@/lib/duration';
import { isFractionSettingKey } from '@/lib/fraction';
import { formatMicroUsd, isMoneySettingKey } from '@/lib/money';
import { sameRouting } from '@/lib/provider-routing-form';
import { type ModelCatalogs, modelFieldHasList, modelFieldOf } from '@/lib/setting-references';

/**
 * The vocabulary of the settings forms, shared by both of them.
 *
 * There are two since issue #52: the deployment-wide form in the admin area
 * and the override form inside a workspace. They render the same keys with the
 * same words and the same bounds, and a second copy of 60 German labels is a
 * second copy that drifts. The words themselves live in the `settings`
 * catalogue, read through `setting-copy.ts`.
 */

/**
 * Choices for settings whose schema is a `z.enum`. Only listed keys render as a
 * dropdown; everything else still derives its control from the runtime value
 * type, so an ordinary string setting added later needs no entry here. The
 * label of a choice is `settings.row.choices.<setting name>.<value>`.
 */
const SETTING_CHOICES = {
  'ai.pdfExtractor': ['docling', 'openrouter'],
  'ai.untrustedContentPolicy': ['guarded', 'deny', 'allow'],
  'ai.writeMode': ['direct', 'propose', 'read_only'],
} as const satisfies Partial<Record<SettingKey, readonly string[]>>;

type ChoiceKey = keyof typeof SETTING_CHOICES;

function hasChoices(key: SettingKey): key is ChoiceKey {
  return key in SETTING_CHOICES;
}

/** The dropdown entries of a setting that has a closed set, in the reader's language. */
function useSettingChoices(): (
  key: SettingKey,
) => readonly { value: string; label: string }[] | undefined {
  const t = useTranslations('settings.row.choices');
  return React.useCallback(
    (key: SettingKey) => {
      if (!hasChoices(key)) return undefined;
      if (key === 'ai.pdfExtractor') {
        return SETTING_CHOICES[key].map((value) => ({
          value,
          label: t(`pdfExtractor.${value}`),
        }));
      }
      if (key === 'ai.writeMode') {
        return SETTING_CHOICES[key].map((value) => ({ value, label: t(`writeMode.${value}`) }));
      }
      return SETTING_CHOICES[key].map((value) => ({
        value,
        label: t(`untrustedContentPolicy.${value}`),
      }));
    },
    [t],
  );
}

export function groupOf(key: SettingKey): string {
  return key.split('.')[0] ?? key;
}

export function inputId(key: SettingKey): string {
  return `setting-${key.replace(/\./g, '-')}`;
}

/**
 * The words about a numeric setting's bounds, in the reader's language.
 *
 * The range is derived from `SETTING_NUMBER_RANGES`, never typed out, so it
 * cannot say something different from what the API validates (issue #28).
 * `rangeHint` is the help text's tail under a numeric field; `invalidMessage`
 * is what to say about a value the schema refused.
 */
/**
 * The bounds a person can type. A setting whose 0 means "no limit" takes its 0
 * through the switch beside the number (issue #202), so the typed range starts
 * at 1 and the help text does not offer the 0 as a count.
 */
function typedRange(key: SettingKey): SettingNumberRange | undefined {
  const range = SETTING_NUMBER_RANGES[key];
  if (range === undefined || SETTING_ZERO_MEANS[key] === undefined) return range;
  return { min: Math.max(range.min, 1), max: range.max };
}

export function useSettingMessages(): {
  rangeHint: (key: SettingKey) => string | null;
  invalidMessage: (key: SettingKey) => string;
} {
  const t = useTranslations('settings.row');
  const duration = useDurationWords();
  const format = useFormatter();
  return React.useMemo(() => {
    // A byte setting names its bounds in the unit each reads best in
    // (`1 KiB bis 50 MiB`), never as 52428800 (issue #174), and a duration in
    // its own (`1 Minute bis 30 Tage`, never 60 to 2592000, issue #169), and
    // money in dollars (`0,001 $ bis 50,00 $`, never 1000 to 50000000, #167),
    // and a share as a percentage (`0 % bis 100 %`, never 0 to 1, #170).
    const bytes = (value: number): string => {
      const { amount, unit } = describeBytes(value);
      return t('byteAmount', { amount, unit: t(`byteUnits.${unit}`) });
    };
    const inUnits = (key: SettingKey): ((value: number) => string) | null => {
      if (isByteSettingKey(key)) return bytes;
      if (isMoneySettingKey(key)) return (value: number) => formatMicroUsd(format, value);
      if (isFractionSettingKey(key)) {
        return (value: number) =>
          format.number(value, { style: 'percent', maximumFractionDigits: 2 });
      }
      const base = durationBaseOfSettingKey(key);
      return base === null ? null : (value: number) => duration(value, base);
    };
    return {
      rangeHint: (key: SettingKey) => {
        const range = typedRange(key);
        // An hour of the day is picked from a list that holds nothing else.
        if (range === undefined || isHourOfDaySettingKey(key)) return null;
        const words = inUnits(key);
        return words === null
          ? t('rangeHint', { min: range.min, max: range.max })
          : t('rangeHintAmounts', { min: words(range.min), max: words(range.max) });
      },
      invalidMessage: (key: SettingKey) => {
        const range = typedRange(key);
        if (range === undefined) return t('invalid');
        const words = inUnits(key);
        return words === null
          ? t('invalidWithRange', { min: range.min, max: range.max })
          : t('invalidWithRangeAmounts', { min: words(range.min), max: words(range.max) });
      },
    };
  }, [t, duration, format]);
}

/**
 * Per-setting messages for a rejected save.
 *
 * The API reports which key failed in `details[].path` (see `ZodValidationPipe`),
 * but the shape crosses an `unknown` boundary, so it is narrowed here instead of
 * trusted. Anything unrecognisable yields no field message and leaves the
 * summary alert as the only feedback. `message` is `invalidMessage` from
 * `useSettingMessages`, handed in so this stays pure.
 */
export function fieldErrorsFromDetails(
  details: unknown,
  message: (key: SettingKey) => string,
): Partial<Record<SettingKey, string>> {
  if (!Array.isArray(details)) return {};
  const errors: Partial<Record<SettingKey, string>> = {};
  for (const entry of details) {
    if (typeof entry !== 'object' || entry === null || !('path' in entry)) continue;
    const path = (entry as { path: unknown }).path;
    // An issue inside an object setting names the path below it
    // (`ai.providerRouting.sort`), so the key is the longest known prefix.
    if (typeof path !== 'string') continue;
    const key = SETTING_KEYS.find(
      (candidate) => path === candidate || path.startsWith(`${candidate}.`),
    );
    if (key === undefined) continue;
    errors[key] = message(key);
  }
  return errors;
}

/**
 * The list the rows stand in. From sm up the rows are spaced; below it they
 * are separated by rules, because on a phone the label no longer has a column
 * of its own and a stack of labels, fields and help texts runs together
 * without them (P12, decided 2026-09-24). A row's wrapper adds `max-sm:py-4`.
 */
export const SETTING_LIST_CLASS =
  'flex flex-col gap-4 max-sm:gap-0 max-sm:divide-y max-sm:divide-border';

/**
 * Whether two values of one setting say the same thing.
 *
 * Every setting used to be a scalar and `!==` was enough. An object setting
 * (`ai.providerRouting`) is rebuilt on every keystroke, so identity would call
 * it changed after it was typed back to what is stored, and the form writes
 * its keys in its own order, which is no change either.
 */
export function sameSettingValue(a: Settings[SettingKey], b: Settings[SettingKey]): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return a === b;
  return sameRouting(a, b);
}

/** What a byte field shows, and the byte count that text last stood for. */
interface ByteDraft {
  amount: string;
  unit: ByteUnit;
  bytes: number;
  inexact: boolean;
}

function byteDraftOf(bytes: number): ByteDraft {
  const unit = preferredByteUnit(bytes);
  return { amount: amountInUnit(bytes, unit), unit, bytes, inexact: false };
}

/**
 * A byte-valued setting, edited as an amount and a unit (issue #174).
 *
 * The stored value stays bytes; the field converts both ways without rounding
 * (`lib/byte-size.ts`). An amount that names no whole number of bytes does not
 * reach the draft, the field says so, and the draft keeps the last value that
 * was exact. Changing the unit keeps the number and changes what it means,
 * which is what somebody who typed "500" and then picked MB intended.
 */
function ByteSettingField({
  settingKey,
  value,
  onChange,
  described,
  id,
}: {
  settingKey: SettingKey;
  value: number;
  onChange: (value: Settings[SettingKey]) => void;
  described: { 'aria-describedby': string; 'aria-invalid': boolean };
  id: string;
}) {
  const t = useTranslations('settings.row');
  const [draft, setDraft] = React.useState(() => byteDraftOf(value));
  // A value that changed from outside (a discarded draft, a reload) replaces
  // the text; one this field emitted itself is already what it shows.
  if (draft.bytes !== value) setDraft(byteDraftOf(value));
  const inexactId = `${id}-bytes-inexact`;

  function update(amount: string, unit: ByteUnit): void {
    const bytes = bytesFromAmount(amount, unit);
    if (bytes === null) {
      setDraft({ amount, unit, bytes: draft.bytes, inexact: true });
      return;
    }
    setDraft({ amount, unit, bytes, inexact: false });
    onChange(bytes);
  }

  return (
    <>
      <div className="flex gap-2">
        <Input
          id={id}
          name={settingKey}
          type="number"
          inputMode="decimal"
          autoComplete="off"
          min={0}
          step="any"
          className="min-w-0 flex-1"
          value={draft.amount}
          {...described}
          aria-invalid={described['aria-invalid'] || draft.inexact}
          aria-describedby={
            draft.inexact
              ? `${described['aria-describedby']} ${inexactId}`
              : described['aria-describedby']
          }
          onChange={(event) => update(event.target.value, draft.unit)}
        />
        <Select
          value={draft.unit}
          onValueChange={(next) => {
            const unit = BYTE_UNITS.find((candidate) => candidate === next);
            if (unit !== undefined) update(draft.amount, unit);
          }}
        >
          <SelectTrigger
            className="w-24 shrink-0"
            aria-label={t('byteUnit')}
            data-testid={`${id}-unit`}
          >
            <SelectValue>{() => t(`byteUnits.${draft.unit}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {BYTE_UNITS.map((unit) => (
              <SelectItem key={unit} value={unit}>
                {t(`byteUnits.${unit}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {draft.inexact ? (
        <p id={inexactId} className="text-xs text-destructive-text" data-testid={inexactId}>
          {t('bytesInexact')}
        </p>
      ) : null}
    </>
  );
}

/**
 * A numeric setting: an amount with a unit for bytes and durations, dollars
 * for money, a percentage for a share, a number and a switch where 0 means no
 * limit, a time for an hour of the day, a plain number otherwise.
 */
function NumberSettingField({
  settingKey,
  value,
  onChange,
  described,
  id,
}: {
  settingKey: SettingKey;
  value: number;
  onChange: (value: Settings[SettingKey]) => void;
  described: { 'aria-describedby': string; 'aria-invalid': boolean };
  id: string;
}) {
  if (isByteSettingKey(settingKey)) {
    return (
      <ByteSettingField
        settingKey={settingKey}
        value={value}
        onChange={onChange}
        described={described}
        id={id}
      />
    );
  }
  if (isMoneySettingKey(settingKey)) {
    const bounds = SETTING_NUMBER_RANGES[settingKey];
    return (
      <MoneyInput
        id={id}
        name={settingKey}
        value={value}
        onChange={(next) => {
          if (next !== null) onChange(next);
        }}
        {...(bounds === undefined ? {} : { min: bounds.min, max: bounds.max })}
        keepsLastValid
        {...described}
      />
    );
  }
  if (isFractionSettingKey(settingKey)) {
    return (
      <FractionSettingField
        settingKey={settingKey}
        value={value}
        onChange={onChange}
        described={described}
        id={id}
      />
    );
  }
  if (SETTING_ZERO_MEANS[settingKey] !== undefined) {
    return (
      <ZeroMeansSettingField
        settingKey={settingKey}
        value={value}
        onChange={onChange}
        described={described}
        id={id}
      />
    );
  }
  if (isHourOfDaySettingKey(settingKey)) {
    return <HourSettingField value={value} onChange={onChange} described={described} id={id} />;
  }
  const base = durationBaseOfSettingKey(settingKey);
  if (base !== null) {
    const bounds = SETTING_NUMBER_RANGES[settingKey];
    return (
      <DurationInput
        id={id}
        name={settingKey}
        base={base}
        value={value}
        onChange={(next) => {
          if (next !== null) onChange(next);
        }}
        {...(bounds === undefined ? {} : { min: bounds.min, max: bounds.max })}
        keepsLastValid
        {...described}
      />
    );
  }
  const range = SETTING_NUMBER_RANGES[settingKey];
  return (
    <Input
      id={id}
      name={settingKey}
      type="number"
      inputMode="numeric"
      // A deployment setting is not a thing a password manager or an
      // autofill heuristic has ever seen before, so neither should offer to
      // fill it in.
      autoComplete="off"
      value={value}
      // Bounds come from the schema (`SETTING_NUMBER_RANGES`), so the spinner
      // stops where the API does instead of offering values it will refuse.
      {...(range === undefined ? {} : { min: range.min, max: range.max, step: 1 })}
      {...described}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (!Number.isNaN(next)) onChange(next);
      }}
    />
  );
}

/**
 * The control of a setting that names something by id, a model or the entity
 * database (issue #171), or `null` for every other setting and for a model
 * field that has no list to offer here.
 */
function referenceControl({
  settingKey,
  value,
  onChange,
  models,
  catalogs,
  described,
  id,
}: {
  settingKey: SettingKey;
  value: Settings[SettingKey];
  onChange: (value: Settings[SettingKey]) => void;
  models: AiModel[];
  catalogs: ModelCatalogs | undefined;
  described: { 'aria-describedby': string; 'aria-invalid': boolean };
  id: string;
}): React.ReactNode {
  if (typeof value !== 'string' && value !== null) return null;
  if (settingKey === 'entities.databaseId') {
    return (
      <EntityDatabaseField
        settingKey={settingKey}
        value={value}
        onChange={onChange}
        described={described}
        id={id}
      />
    );
  }
  const field = modelFieldOf(settingKey);
  if (field === undefined || !modelFieldHasList(field, catalogs)) return null;
  return (
    <ModelSettingField
      settingKey={settingKey}
      field={field}
      value={value}
      onChange={onChange}
      models={models}
      catalogs={catalogs}
      described={described}
      id={id}
    />
  );
}

export interface SettingRowProps {
  settingKey: SettingKey;
  value: Settings[SettingKey];
  onChange: (value: Settings[SettingKey]) => void;
  models: AiModel[];
  /**
   * The provider's embedding and image models, for the two settings that name
   * an OpenRouter slug (issue #171). Absent where the form may not read the
   * catalogue: the vector model then lists the measured slugs alone, and the
   * image model stays a text field.
   */
  catalogs?: ModelCatalogs;
  /** Set when the last save attempt refused this value. */
  error?: string;
  /**
   * The value on the server, for a control that says what saving would
   * change rather than only what the draft is (the webhook host list).
   */
  stored?: Settings[SettingKey];
}

/**
 * One form row. The control is derived from the *runtime* value type (plus
 * the model settings `model-setting-field.tsx` lists), not from a hardcoded
 * per-key list, so a setting added later to `settingsSchema` renders here
 * automatically.
 */
export function SettingRow({
  settingKey,
  value,
  onChange,
  models,
  catalogs,
  error,
  stored,
}: SettingRowProps) {
  const t = useTranslations('settings.row');
  const copy = useSettingCopy()(settingKey);
  const choices = useSettingChoices()(settingKey);
  const { rangeHint } = useSettingMessages();
  const id = inputId(settingKey);
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;

  const hint = rangeHint(settingKey);

  /*
   * The description every control on this row carries, whatever kind of control
   * it turned out to be.
   *
   * The help text under a setting is not a hint here, it is the safety
   * mechanism: it is where a switch says that it lets a model reach addresses
   * it chooses itself, or that it spends money. Rendered as a loose paragraph
   * after the control, a screen reader never reads it as belonging to the
   * switch, so the switch is operated blind. The same goes for a refusal: it
   * was announced by nothing and reachable only by accident.
   *
   * There is no `role="alert"` on the message, and that is deliberate. A save
   * that is refused moves focus to the first offending field (`settings-form`),
   * which announces the control together with this description; an alert per
   * refused field would then say the same thing again, once per field.
   */
  const described = {
    'aria-describedby': error === undefined ? helpId : `${helpId} ${errorId}`,
    'aria-invalid': error !== undefined,
  };

  const reference = referenceControl({
    settingKey,
    value,
    onChange,
    models,
    catalogs,
    described,
    id,
  });

  let control: React.ReactNode;
  if (reference !== null) {
    control = reference;
  } else if (choices !== undefined) {
    control = (
      <Select value={typeof value === 'string' ? value : ''} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full" {...described}>
          {/* Base UI shows the raw value without a render function. */}
          <SelectValue>
            {() => choices.find((choice) => choice.value === value)?.label ?? ''}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (typeof value === 'boolean') {
    control = <Switch id={id} checked={value} onCheckedChange={onChange} {...described} />;
  } else if (typeof value === 'number') {
    control = (
      <NumberSettingField
        settingKey={settingKey}
        value={value}
        onChange={onChange}
        described={described}
        id={id}
      />
    );
  } else if (settingKey === 'ai.providerRouting' && typeof value === 'object') {
    // Half-filled is not a value yet: only a form that describes one reaches
    // the draft, which keeps the last valid object until then (issue #201).
    control = (
      <ProviderRoutingEditor
        id={id}
        mode="setting"
        value={value}
        describedBy={described['aria-describedby']}
        invalid={described['aria-invalid']}
        onChange={(next) => {
          if (next !== undefined) onChange(next);
        }}
      />
    );
  } else {
    control = (
      <TextSettingField
        settingKey={settingKey}
        value={typeof value === 'string' ? value : ''}
        stored={typeof stored === 'string' ? stored : undefined}
        onChange={onChange}
        described={described}
        id={id}
      />
    );
  }

  // Below sm a switch sits on its label's line, the way a phone sets one
  // (P12, decided 2026-09-24): the wrapper dissolves into the row's grid, the
  // switch takes the second column of the first line, and the help text runs
  // under both. From sm up the row is the same two columns as every other.
  const isSwitch = typeof value === 'boolean';

  return (
    <div
      // The row rather than the control, because Base UI puts `id` on a
      // switch's hidden input: the thing a person clicks has no id of its own.
      data-testid={`setting-row-${settingKey}`}
      // minmax(0,1fr) below sm too: an auto track grows to the longest
      // select label, and on a phone that pushed the row off the screen.
      className={cn(
        'grid gap-1.5 sm:grid-cols-[minmax(0,240px)_1fr] sm:items-start sm:gap-4',
        isSwitch ? 'grid-cols-[minmax(0,1fr)_auto] gap-x-3' : 'grid-cols-[minmax(0,1fr)]',
      )}
    >
      <Label htmlFor={id} className={cn('pt-2', isSwitch && 'max-sm:self-center max-sm:pt-0')}>
        {copy.label}
      </Label>
      <div
        className={cn(
          'flex max-w-md flex-col gap-1',
          isSwitch && 'max-sm:contents max-sm:[&>:not(:first-child)]:col-span-2',
        )}
      >
        {control}
        <p id={helpId} className="text-xs text-muted-foreground">
          {[copy.help, hint, isByteSettingKey(settingKey) ? t('byteUnitsExplained') : null]
            .filter((part) => part !== null)
            .join(' ')}
        </p>
        {error === undefined ? null : (
          <p id={errorId} className="text-xs text-destructive-text" data-testid={`${id}-error`}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
