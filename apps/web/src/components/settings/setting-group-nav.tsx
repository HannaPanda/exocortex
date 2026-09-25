'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { TabsList, TabsTrigger } from '@exocortex/ui';

import { useSettingGroupLabel } from '@/components/settings/setting-copy';

/**
 * The list of setting groups, shared by the two settings forms.
 *
 * Both forms hold far more rows than fit on a screen -- around forty in a
 * workspace, over a hundred for the deployment -- and a column that long is
 * one nobody reads to the end of. The groups the settings already have become
 * the navigation, one group on screen at a time.
 *
 * The forms stay separate (they answer different questions, see
 * `WorkspaceSettingsForm`); only the list is shared, because two copies of it
 * would drift apart the first time a group gains a marker.
 *
 * Both markers exist because the panel shows one group and the save button
 * covers all of them: an edit or a refusal in a group that is off screen would
 * otherwise be invisible. A refusal wins over a pending edit -- it is the one
 * that needs a hand.
 */
export function SettingGroupNav({
  groups,
  pending,
  invalid,
  testIdPrefix,
}: {
  groups: readonly string[];
  /** Groups holding an unsaved edit. */
  pending: ReadonlySet<string>;
  /** Groups holding a value the last save refused. */
  invalid: ReadonlySet<string>;
  testIdPrefix: string;
}) {
  const t = useTranslations('settings.groupNav');
  const groupLabel = useSettingGroupLabel();
  return (
    <TabsList className="h-auto w-full flex-row flex-wrap items-stretch gap-0.5 overflow-visible bg-transparent p-0 md:w-52 md:shrink-0 md:flex-col">
      {groups.map((group) => (
        <TabsTrigger
          key={group}
          value={group}
          data-testid={`${testIdPrefix}-${group}`}
          className="flex-none justify-start gap-2 py-1.5 ps-3 pe-2.5 text-sm"
        >
          <span className="truncate">{groupLabel(group)}</span>
          {invalid.has(group) ? (
            <span
              aria-label={t('rejected')}
              className="ms-auto size-1.5 shrink-0 rounded-full bg-destructive"
            />
          ) : pending.has(group) ? (
            <span
              aria-label={t('pending')}
              className="ms-auto size-1.5 shrink-0 rounded-full bg-primary"
            />
          ) : null}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
