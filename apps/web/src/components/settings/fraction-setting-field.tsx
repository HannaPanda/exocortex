'use client';

import * as React from 'react';

import type { SettingKey, Settings } from '@exocortex/contracts';
import { Input } from '@exocortex/ui';

import { fractionOfPercent, percentOfFraction } from '@/lib/fraction';

/**
 * A share between 0 and 1, edited as a percentage (issue #170). The field
 * used to be a plain number with `step=1`, so the browser called the default
 * 0.15 invalid and the arrow keys jumped between 0 and 1.
 *
 * The text is the field's own state, because `12.` is not a value yet; only a
 * number between 0 and 100 reaches the draft.
 */
export function FractionSettingField({
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
  const [draft, setDraft] = React.useState(() => ({
    text: String(percentOfFraction(value)),
    fraction: value,
  }));
  // A value that changed from outside (a discarded draft, a reload) replaces
  // the text; one this field emitted itself is already what it shows.
  if (draft.fraction !== value)
    setDraft({ text: String(percentOfFraction(value)), fraction: value });

  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        name={settingKey}
        type="number"
        inputMode="decimal"
        autoComplete="off"
        min={0}
        max={100}
        step="any"
        className="w-28"
        value={draft.text}
        {...described}
        onChange={(event) => {
          const text = event.target.value;
          const fraction = fractionOfPercent(text);
          setDraft({ text, fraction: fraction ?? draft.fraction });
          if (fraction !== null) onChange(fraction);
        }}
      />
      <span className="text-sm text-muted-foreground" aria-hidden="true">
        %
      </span>
    </div>
  );
}
