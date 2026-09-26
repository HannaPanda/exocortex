'use client';

import { Settings2Icon, SettingsIcon, SparklesIcon, UsersIcon } from 'lucide-react';
import { type useTranslations } from 'next-intl';
import * as React from 'react';

import { SETTING_GROUPS } from '@/components/settings/setting-copy';

import { keywordsOf, type PaletteCommand, type PaletteContext } from './palette-command';
import { SETTING_GROUP_PARAM, WORKSPACE_TAB_PARAM } from './settings-addresses';

const ICON = 'size-4 text-muted-foreground';

const WORKSPACE_ADMIN_ROLES = new Set(['OWNER', 'ADMIN']);

/**
 * Every settings area by its own name (issue #148).
 *
 * The deployment's groups are read from `SETTING_GROUPS`, not listed here, so
 * a new group is a new command the day it exists: somebody typing "kalender"
 * lands on the calendar settings without anybody having remembered to add
 * it. Its search words are the one thing that cannot be derived, and
 * `check-palette-coverage.mjs` refuses a group without them.
 *
 * A group opens as `?gruppe=<group>` on the settings page, which is also an
 * address that can be bookmarked or pasted into a message.
 */
export function settingsCommands(
  context: PaletteContext,
  t: ReturnType<typeof useTranslations<'shell.paletteCommands.settings'>>,
  groupLabel: (group: string) => string,
): PaletteCommand[] {
  const commands: PaletteCommand[] = [];

  if (context.role === 'admin') {
    for (const group of SETTING_GROUPS) {
      commands.push({
        id: `settings-group-${group}`,
        group: 'settings',
        label: t('adminGroup', { group: groupLabel(group) }),
        hint: t('adminHint'),
        icon: <Settings2Icon className={ICON} />,
        keywords: [...keywordsOf(t('adminKeywords')), ...keywordsOf(t(`groups.${group}`))],
        href: `/admin/einstellungen?${SETTING_GROUP_PARAM}=${group}`,
      });
    }
  }

  const workspaceId = context.workspaceId;
  if (workspaceId !== null) {
    const base = `/arbeitsbereich/${workspaceId}/einstellungen?${WORKSPACE_TAB_PARAM}=`;
    // Only somebody who may change who is in the workspace is offered the
    // tab for it: the settings page hides it from everybody else, and the
    // command would open the first tab instead, which is a quiet lie.
    if (context.workspaceRole !== null && WORKSPACE_ADMIN_ROLES.has(context.workspaceRole)) {
      commands.push({
        id: 'settings-workspace-members',
        group: 'settings',
        label: t('workspaceMembers'),
        icon: <UsersIcon className={ICON} />,
        keywords: keywordsOf(t('workspaceMembersKeywords')),
        href: `${base}members`,
      });
    }
    commands.push(
      {
        id: 'settings-workspace-ai',
        group: 'settings',
        label: t('workspaceAi'),
        icon: <SparklesIcon className={ICON} />,
        keywords: keywordsOf(t('workspaceAiKeywords')),
        href: `${base}ai`,
      },
      {
        id: 'settings-workspace-overrides',
        group: 'settings',
        label: t('workspaceOverrides'),
        icon: <Settings2Icon className={ICON} />,
        keywords: keywordsOf(t('workspaceOverridesKeywords')),
        href: `${base}overrides`,
      },
    );
  }

  return commands;
}

const ACCOUNT_PLACES = new Set([
  'navigate-connections',
  'navigate-notifications',
  'navigate-language',
]);
const WORKSPACE_PLACES = new Set(['navigate-workspaceSettings']);
const ADMIN_PLACES = new Set(['navigate-adminSettings', 'navigate-adminModels']);

/**
 * "Einstellungen → Verwaltung → KI" (issue #148): every settings place and
 * group again, sorted by whose settings they are, for somebody who does not
 * know the word to type and wants to look.
 *
 * Built from the commands that already exist rather than a second list, so
 * a group added to `SETTING_GROUPS` shows up here the same day. Not
 * searchable: each entry is already found by its own name at the top, and
 * listing it twice would say nothing new. Inside the menu a group is named
 * by itself, "KI" under "Verwaltung" rather than "Einstellungen: KI".
 */
export function settingsMenu(
  navigation: readonly PaletteCommand[],
  settings: readonly PaletteCommand[],
  t: ReturnType<typeof useTranslations<'shell.paletteCommands.settings'>>,
  groupLabel: (group: string) => string,
): PaletteCommand[] {
  const pick = (ids: Set<string>) => navigation.filter((command) => ids.has(command.id));
  const adminGroups = settings
    .filter((command) => command.id.startsWith('settings-group-'))
    .map((command) => ({
      ...command,
      label: groupLabel(command.id.slice('settings-group-'.length)),
      hint: undefined,
    }));
  const sections = [
    { id: 'account', label: t('menuAccount'), entries: pick(ACCOUNT_PLACES) },
    {
      id: 'workspace',
      label: t('menuWorkspace'),
      entries: [
        ...pick(WORKSPACE_PLACES),
        ...settings.filter((command) => command.id.startsWith('settings-workspace-')),
      ],
    },
    { id: 'admin', label: t('menuAdmin'), entries: [...pick(ADMIN_PLACES), ...adminGroups] },
  ].filter((section) => section.entries.length > 0);

  return [
    {
      id: 'settings-menu',
      group: 'settings',
      label: t('menu'),
      placeholder: t('menuPlaceholder'),
      icon: <SettingsIcon className={ICON} />,
      keywords: keywordsOf(t('menuKeywords')),
      children: () =>
        sections.map<PaletteCommand>((section) => ({
          id: `settings-menu-${section.id}`,
          group: 'settings',
          label: section.label,
          icon: <Settings2Icon className={ICON} />,
          keywords: [],
          children: () => section.entries,
        })),
    },
  ];
}
