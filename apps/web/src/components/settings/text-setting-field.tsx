'use client';

import type { SettingKey, Settings } from '@exocortex/contracts';
import { Input, Textarea } from '@exocortex/ui';

import { HostListSettingField } from '@/components/settings/host-list-field';
import { TimeZonePicker } from '@/components/time-zone-picker';
import { isHostListSettingKey } from '@/lib/webhook-hosts';

/** The string settings that hold an IANA zone (issue #172). */
const TIME_ZONE_SETTING_KEYS: ReadonlySet<SettingKey> = new Set([
  'calendar.timeZone',
  'notifications.digestTimeZone',
]);

/** A string setting: a host list, a time zone, the system prompt, or one line of text. */
export function TextSettingField({
  settingKey,
  value,
  stored,
  onChange,
  described,
  id,
}: {
  settingKey: SettingKey;
  value: string;
  stored: string | undefined;
  onChange: (value: Settings[SettingKey]) => void;
  described: { 'aria-describedby': string; 'aria-invalid': boolean };
  id: string;
}) {
  if (isHostListSettingKey(settingKey)) {
    return (
      <HostListSettingField
        settingKey={settingKey}
        value={value}
        stored={stored}
        onChange={onChange}
        described={described}
        id={id}
      />
    );
  }
  if (TIME_ZONE_SETTING_KEYS.has(settingKey)) {
    return (
      <TimeZonePicker
        id={id}
        value={value}
        onChange={onChange}
        aria-describedby={described['aria-describedby']}
        aria-invalid={described['aria-invalid']}
        className="max-w-80"
      />
    );
  }
  if (settingKey === 'ai.systemPrompt') {
    return (
      <Textarea
        id={id}
        name={settingKey}
        rows={4}
        value={value}
        {...described}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <Input
      id={id}
      name={settingKey}
      type="text"
      autoComplete="off"
      // These are slugs and model identifiers, not prose.
      spellCheck={false}
      value={value}
      {...described}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
