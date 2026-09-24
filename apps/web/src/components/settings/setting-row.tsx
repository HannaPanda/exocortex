'use client';

import * as React from 'react';

import {
  type AiModel,
  SETTING_KEYS,
  SETTING_NUMBER_RANGES,
  type SettingKey,
  type Settings,
} from '@exocortex/contracts';
import {
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

import { SETTING_COPY } from '@/components/settings/setting-copy';

/**
 * The vocabulary of the settings forms, shared by both of them.
 *
 * There are two since issue #52: the deployment-wide form in the admin area
 * and the override form inside a workspace. They render the same keys with the
 * same words and the same bounds, and a second copy of 60 German labels is a
 * second copy that drifts. The words themselves live in `setting-copy.ts`.
 */

/** Sentinel for "no model chosen"; distinct from every real slug. */
const AUTO_VALUE = '__automatic__';

/**
 * Choices for settings whose schema is a `z.enum`. Only listed keys render as a
 * dropdown; everything else still derives its control from the runtime value
 * type, so an ordinary string setting added later needs no entry here.
 */
const SETTING_CHOICES: Partial<Record<SettingKey, readonly { value: string; label: string }[]>> = {
  'ai.pdfExtractor': [
    { value: 'docling', label: 'Docling (lokal, kostenlos, mit Texterkennung)' },
    { value: 'openrouter', label: 'OpenRouter (gehostet, kostenpflichtig, ohne Texterkennung)' },
  ],
  'ai.untrustedContentPolicy': [
    { value: 'guarded', label: 'Gesperrt, sobald Fremdinhalte gelesen wurden (empfohlen)' },
    { value: 'deny', label: 'Nie: die KI darf in keinem Lauf etwas verändern' },
    { value: 'allow', label: 'Immer erlaubt, auch nach Fremdinhalten' },
  ],
};

export function groupOf(key: SettingKey): string {
  return key.split('.')[0] ?? key;
}

export function inputId(key: SettingKey): string {
  return `setting-${key.replace(/\./g, '-')}`;
}

const numberFormat = new Intl.NumberFormat('de-DE');

/**
 * The permitted range in words, for the help text under a numeric field.
 *
 * Derived from `SETTING_NUMBER_RANGES`, never typed out, so it cannot say
 * something different from what the API validates (issue #28).
 */
export function rangeHint(key: SettingKey): string | null {
  const range = SETTING_NUMBER_RANGES[key];
  if (range === undefined) return null;
  return `Zulässig: ${numberFormat.format(range.min)} bis ${numberFormat.format(range.max)}.`;
}

/** What to say about a value the schema refused. */
export function invalidMessage(key: SettingKey): string {
  const hint = rangeHint(key);
  return hint === null ? 'Dieser Wert ist nicht gültig.' : `Nicht gespeichert. ${hint}`;
}

/**
 * Per-setting messages for a rejected save.
 *
 * The API reports which key failed in `details[].path` (see `ZodValidationPipe`),
 * but the shape crosses an `unknown` boundary, so it is narrowed here instead of
 * trusted. Anything unrecognisable yields no field message and leaves the
 * summary alert as the only feedback.
 */
export function fieldErrorsFromDetails(details: unknown): Partial<Record<SettingKey, string>> {
  if (!Array.isArray(details)) return {};
  const errors: Partial<Record<SettingKey, string>> = {};
  for (const entry of details) {
    if (typeof entry !== 'object' || entry === null || !('path' in entry)) continue;
    const path = (entry as { path: unknown }).path;
    // Every setting is a scalar, so the issue path is the setting key itself.
    if (typeof path !== 'string' || !(SETTING_KEYS as readonly string[]).includes(path)) continue;
    errors[path as SettingKey] = invalidMessage(path as SettingKey);
  }
  return errors;
}

export interface SettingRowProps {
  settingKey: SettingKey;
  value: Settings[SettingKey];
  onChange: (value: Settings[SettingKey]) => void;
  models: AiModel[];
  /** Set when the last save attempt refused this value. */
  error?: string;
}

/**
 * One form row. The control is derived from the *runtime* value type (plus the
 * `*ModelSlug` naming convention), not from a hardcoded per-key list, so a
 * setting added later to `settingsSchema` renders here automatically.
 */
export function SettingRow({ settingKey, value, onChange, models, error }: SettingRowProps) {
  const copy = SETTING_COPY[settingKey];
  const id = inputId(settingKey);
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;

  const choices = SETTING_CHOICES[settingKey];
  const range = SETTING_NUMBER_RANGES[settingKey];
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
  } else if (settingKey.endsWith('ModelSlug')) {
    control = (
      <Select
        value={value ?? AUTO_VALUE}
        onValueChange={(next) => onChange(next === AUTO_VALUE ? null : next)}
      >
        <SelectTrigger id={id} className="w-full" {...described}>
          <SelectValue>
            {() => models.find((model) => model.slug === value)?.displayName ?? 'Automatisch'}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO_VALUE}>Automatisch</SelectItem>
          {models.map((model) => (
            <SelectItem key={model.slug} value={model.slug}>
              {model.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (settingKey === 'ai.systemPrompt') {
    control = (
      <Textarea
        id={id}
        name={settingKey}
        rows={4}
        value={typeof value === 'string' ? value : ''}
        {...described}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  } else {
    control = (
      <Input
        id={id}
        name={settingKey}
        type="text"
        autoComplete="off"
        // These are slugs, model identifiers and hosts, not prose.
        spellCheck={false}
        value={typeof value === 'string' ? value : ''}
        {...described}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <div
      // The row rather than the control, because Base UI puts `id` on a
      // switch's hidden input: the thing a person clicks has no id of its own.
      data-testid={`setting-row-${settingKey}`}
      // minmax(0,1fr) below sm too: an auto track grows to the longest
      // select label, and on a phone that pushed the row off the screen.
      className="grid grid-cols-[minmax(0,1fr)] gap-1.5 sm:grid-cols-[minmax(0,240px)_1fr] sm:items-start sm:gap-4"
    >
      <Label htmlFor={id} className="pt-2">
        {copy.label}
      </Label>
      <div className="flex max-w-md flex-col gap-1">
        {control}
        <p id={helpId} className="text-xs text-muted-foreground">
          {hint === null ? copy.help : `${copy.help} ${hint}`}
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
