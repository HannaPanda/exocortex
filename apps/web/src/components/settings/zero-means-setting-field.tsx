'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  limitedValueOf,
  SETTING_NUMBER_RANGES,
  SETTING_ZERO_MEANS,
  type SettingKey,
  type Settings,
} from '@exocortex/contracts';
import { Input, Label, Switch } from '@exocortex/ui';

/** The text a stored value shows: nothing while the switch says there is no limit. */
function textOf(value: number): string {
  return value === 0 ? '' : String(value);
}

/**
 * A count of days where 0 means "no limit" (issue #202), edited as a number
 * and a switch beside it. The 0 used to be typed in, and the help text was
 * the only place saying it meant "for ever" rather than "at once".
 *
 * The switch stores the 0 and disables the number; switching it off restores
 * the setting's default, or 30 when the default is the 0 itself. The number
 * itself only ever hands over 1 or more, so clearing the field to type a new
 * count never switches the limit off by accident.
 */
export function ZeroMeansSettingField({
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
  const t = useTranslations('settings.row.zeroMeans');
  const meaning = SETTING_ZERO_MEANS[settingKey] ?? 'unlimited';
  const max = SETTING_NUMBER_RANGES[settingKey]?.max;
  const [draft, setDraft] = React.useState(() => ({ text: textOf(value), value }));
  // A value that changed from outside (a discarded draft, a reload, the
  // switch) replaces the text; one this field emitted itself is already shown.
  if (draft.value !== value) setDraft({ text: textOf(value), value });
  const unlimited = value === 0;
  const switchId = `${id}-zero`;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Input
        id={id}
        name={settingKey}
        type="number"
        inputMode="numeric"
        autoComplete="off"
        min={1}
        {...(max === undefined ? {} : { max })}
        step={1}
        className="w-28"
        disabled={unlimited}
        value={draft.text}
        {...described}
        onChange={(event) => {
          const text = event.target.value;
          const next = Number(text);
          const valid =
            text.trim().length > 0 &&
            Number.isInteger(next) &&
            next >= 1 &&
            (max === undefined || next <= max);
          setDraft({ text, value: valid ? next : draft.value });
          if (valid) onChange(next);
        }}
      />
      <Label htmlFor={switchId} className="gap-2 font-normal">
        <Switch
          id={switchId}
          checked={unlimited}
          // Base UI's switch is a span and its id sits on a hidden input, so
          // the label around it names nothing a screen reader can see.
          aria-labelledby={`${switchId}-label`}
          aria-describedby={described['aria-describedby']}
          data-testid={switchId}
          onCheckedChange={(checked) => onChange(checked ? 0 : limitedValueOf(settingKey))}
        />
        <span id={`${switchId}-label`}>{t(meaning)}</span>
      </Label>
    </div>
  );
}
