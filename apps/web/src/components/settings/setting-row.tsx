'use client';

import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AiModel,
  SETTING_KEYS,
  SETTING_NUMBER_RANGES,
  type SettingKey,
  type Settings,
  settingsSchema,
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
  Textarea,
} from '@exocortex/ui';

import { DurationInput, useDurationWords } from '@/components/duration-input';
import { MoneyInput } from '@/components/money-input';
import { useSettingCopy } from '@/components/settings/setting-copy';
import { TextSettingField } from '@/components/settings/text-setting-field';
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
import { formatMicroUsd, isMoneySettingKey } from '@/lib/money';

/**
 * The vocabulary of the settings forms, shared by both of them.
 *
 * There are two since issue #52: the deployment-wide form in the admin area
 * and the override form inside a workspace. They render the same keys with the
 * same words and the same bounds, and a second copy of 60 German labels is a
 * second copy that drifts. The words themselves live in the `settings`
 * catalogue, read through `setting-copy.ts`.
 */

/** Sentinel for "no model chosen"; distinct from every real slug. */
const AUTO_VALUE = '__automatic__';

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
    // money in dollars (`0,001 $ bis 50,00 $`, never 1000 to 50000000, #167).
    const bytes = (value: number): string => {
      const { amount, unit } = describeBytes(value);
      return t('byteAmount', { amount, unit: t(`byteUnits.${unit}`) });
    };
    const inUnits = (key: SettingKey): ((value: number) => string) | null => {
      if (isByteSettingKey(key)) return bytes;
      if (isMoneySettingKey(key)) return (value: number) => formatMicroUsd(format, value);
      const base = durationBaseOfSettingKey(key);
      return base === null ? null : (value: number) => duration(value, base);
    };
    return {
      rangeHint: (key: SettingKey) => {
        const range = SETTING_NUMBER_RANGES[key];
        // An hour of the day is picked from a list that holds nothing else.
        if (range === undefined || isHourOfDaySettingKey(key)) return null;
        const words = inUnits(key);
        return words === null
          ? t('rangeHint', { min: range.min, max: range.max })
          : t('rangeHintAmounts', { min: words(range.min), max: words(range.max) });
      },
      invalidMessage: (key: SettingKey) => {
        const range = SETTING_NUMBER_RANGES[key];
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
 * it changed after it was typed back to what is stored.
 */
export function sameSettingValue(a: Settings[SettingKey], b: Settings[SettingKey]): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What an object setting's text field shows as its example, when it is empty. */
const JSON_SETTING_PLACEHOLDERS: Partial<Record<SettingKey, string>> = {
  'ai.providerRouting': '{ "sort": "throughput", "ignore": ["relace"] }',
};

/**
 * An object-valued setting, edited as JSON.
 *
 * The text is the field's own state, because half-typed JSON is not a value
 * yet: only text that parses and passes the setting's schema reaches the
 * draft. Until it does, the field says so, and the draft keeps the last
 * value that was valid.
 */
function JsonSettingField({
  settingKey,
  value,
  onChange,
  described,
  id,
}: {
  settingKey: SettingKey;
  value: Settings[SettingKey];
  onChange: (value: Settings[SettingKey]) => void;
  described: { 'aria-describedby': string; 'aria-invalid': boolean };
  id: string;
}) {
  const t = useTranslations('settings.row');
  const [text, setText] = React.useState(() =>
    Object.keys(value ?? {}).length === 0 ? '' : JSON.stringify(value, null, 2),
  );
  const [invalid, setInvalid] = React.useState(false);
  const invalidId = `${id}-json-invalid`;

  function handleChange(next: string): void {
    setText(next);
    let candidate: unknown = {};
    if (next.trim().length > 0) {
      try {
        candidate = JSON.parse(next);
      } catch {
        setInvalid(true);
        return;
      }
    }
    const parsed = settingsSchema.shape[settingKey].safeParse(candidate);
    setInvalid(!parsed.success);
    if (parsed.success) onChange(parsed.data);
  }

  return (
    <>
      <Textarea
        id={id}
        name={settingKey}
        rows={4}
        spellCheck={false}
        className="font-mono text-xs"
        placeholder={JSON_SETTING_PLACEHOLDERS[settingKey]}
        value={text}
        {...described}
        aria-invalid={described['aria-invalid'] || invalid}
        aria-describedby={
          invalid ? `${described['aria-describedby']} ${invalidId}` : described['aria-describedby']
        }
        onChange={(event) => handleChange(event.target.value)}
      />
      {invalid ? (
        <p
          id={invalidId}
          className="text-xs text-destructive-text"
          data-testid={`${id}-json-invalid`}
        >
          {t('jsonInvalid')}
        </p>
      ) : null}
    </>
  );
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
 * An hour of the day (0 to 23), picked as a time (issue #169). The stored
 * value has no minutes, so the list offers whole hours and promises no more.
 * The times are written the reader's way (`09:00`, `9:00 AM`), read in UTC so
 * the browser's own zone cannot shift the label away from the stored hour.
 */
function HourSettingField({
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

/**
 * A numeric setting: an amount with a unit for bytes and durations, dollars
 * for money, a time for an hour of the day, a plain number otherwise.
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

export interface SettingRowProps {
  settingKey: SettingKey;
  value: Settings[SettingKey];
  onChange: (value: Settings[SettingKey]) => void;
  models: AiModel[];
  /** Set when the last save attempt refused this value. */
  error?: string;
  /**
   * The value on the server, for a control that says what saving would
   * change rather than only what the draft is (the webhook host list).
   */
  stored?: Settings[SettingKey];
}

/**
 * One form row. The control is derived from the *runtime* value type (plus the
 * `*ModelSlug` naming convention), not from a hardcoded per-key list, so a
 * setting added later to `settingsSchema` renders here automatically.
 */
export function SettingRow({
  settingKey,
  value,
  onChange,
  models,
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

  let control: React.ReactNode;
  if (choices !== undefined) {
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
  } else if (typeof value === 'object' && value !== null) {
    control = (
      <JsonSettingField
        settingKey={settingKey}
        value={value}
        onChange={onChange}
        described={described}
        id={id}
      />
    );
  } else if (settingKey.endsWith('ModelSlug')) {
    control = (
      <Select
        value={value ?? AUTO_VALUE}
        onValueChange={(next) => onChange(next === AUTO_VALUE ? null : next)}
      >
        <SelectTrigger id={id} className="w-full" {...described}>
          <SelectValue>
            {() => models.find((model) => model.slug === value)?.displayName ?? t('automatic')}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO_VALUE}>{t('automatic')}</SelectItem>
          {models.map((model) => (
            <SelectItem key={model.slug} value={model.slug}>
              {model.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
