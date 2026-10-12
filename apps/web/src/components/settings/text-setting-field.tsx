'use client';

import type { SettingKey, Settings } from '@exocortex/contracts';
import { Input, Textarea } from '@exocortex/ui';

import { HostListSettingField } from '@/components/settings/host-list-field';
import { isHostListSettingKey } from '@/lib/webhook-hosts';

/** A string setting: a host list, the system prompt, or one line of text. */
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
