import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type SettingKey } from '@exocortex/contracts';

/**
 * What every setting is called and what it does, in the words of somebody who
 * has to decide about it, in the reader's language.
 *
 * The words live in the `settings` catalogue (`packages/i18n/src/messages/de/
 * settings.json`), not here. The mapping from a setting key to its messages:
 * next-intl reads `.` as nesting, and every setting key is `<group>.<name>`
 * with exactly one dot, so the key is used as the path as it is. `ai.enabled`
 * is `settings.keys.ai.enabled.label` and `.help`; a group's name is
 * `settings.groups.<group>`. Because the path is built from `SettingKey`, a
 * setting added to the schema without a German label and help text is a
 * compile error here rather than a blank row.
 */
export interface SettingCopy {
  label: string;
  help: string;
}

/** The label and help text of a setting, looked up per key. */
export function useSettingCopy(): (key: SettingKey) => SettingCopy {
  const t = useTranslations('settings.keys');
  return React.useCallback(
    (key: SettingKey) => ({ label: t(`${key}.label`), help: t(`${key}.help`) }),
    [t],
  );
}

/** The groups the settings fall into (the part of a key before the dot). */
export const SETTING_GROUPS = [
  'ai',
  'memory',
  'entities',
  'search',
  'mcp',
  'calendar',
  'notifications',
  'activity',
  'automations',
  'overview',
  'render',
  'projects',
  'agents',
] as const;

export type SettingGroup = (typeof SETTING_GROUPS)[number];

export function isSettingGroup(group: string): group is SettingGroup {
  return (SETTING_GROUPS as readonly string[]).includes(group);
}

/**
 * A group's name for the group list. A group that has no entry yet shows its
 * identifier rather than nothing.
 */
export function useSettingGroupLabel(): (group: string) => string {
  const t = useTranslations('settings.groups');
  return React.useCallback((group: string) => (isSettingGroup(group) ? t(group) : group), [t]);
}
