'use client';

import { Settings2Icon, SettingsIcon } from 'lucide-react';
import { type useTranslations } from 'next-intl';
import * as React from 'react';

import { SETTING_GROUPS } from '@/components/settings/setting-copy';
import { SETTINGS_SECTION_ICONS } from '@/components/settings-dialog/section-icons';
import {
  sectionReaches,
  SETTINGS_SECTIONS,
  type SettingsAudience,
  type SettingsSectionId,
} from '@/components/settings-dialog/sections';

import { keywordsOf, type PaletteCommand, type PaletteContext } from './palette-command';
import { SETTING_GROUP_PARAM } from './settings-addresses';

const ICON = 'size-4 text-muted-foreground';

/**
 * Every group of the deployment's settings by its own name (issue #148).
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

  return commands;
}

/**
 * Whether the reader in `context` may see a group meant for `audience`. A
 * workspace group needs a workspace open underneath: the palette has no
 * other one to name, while the dialog falls back to the first.
 */
export function reachesAudience(audience: SettingsAudience, context: PaletteContext): boolean {
  return sectionReaches(audience, {
    admin: context.role === 'admin',
    workspaceRole: context.workspaceId === null ? null : context.workspaceRole,
  });
}

/**
 * One command per group of the settings dialog (issue #279), read from the
 * dialog's own list, so a group added there is a command the day it exists.
 * Each opens the dialog over the page being read; its label and search words
 * are the ones the dialog's search answers with, under
 * `shell.paletteCommands.settingsSections.<group>`.
 */
export function settingsSectionCommands(
  context: PaletteContext,
  t: ReturnType<typeof useTranslations<'shell.paletteCommands.settingsSections'>>,
  href: (section: SettingsSectionId) => string,
): PaletteCommand[] {
  return SETTINGS_SECTIONS.filter((section) => reachesAudience(section.audience, context)).map(
    (section) => {
      const Icon = SETTINGS_SECTION_ICONS[section.id];
      return {
        id: `settings-section-${section.id}`,
        group: 'settings',
        label: t(`${section.id}.label`),
        icon: <Icon className={ICON} />,
        keywords: keywordsOf(t(`${section.id}.keywords`)),
        href: href(section.id),
      };
    },
  );
}

function sectionCommandIds(area: string): Set<string> {
  return new Set(
    SETTINGS_SECTIONS.filter((section) => section.area === area).map(
      (section) => `settings-section-${section.id}`,
    ),
  );
}
const ACCOUNT_SECTIONS = sectionCommandIds('account');
const WORKSPACE_SECTIONS = sectionCommandIds('workspace');
const ADMIN_SECTIONS = sectionCommandIds('admin');
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
  dialogGroups: readonly PaletteCommand[],
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
  const menus = [
    {
      id: 'account',
      label: t('menuAccount'),
      entries: dialogGroups.filter((command) => ACCOUNT_SECTIONS.has(command.id)),
    },
    {
      id: 'workspace',
      label: t('menuWorkspace'),
      entries: dialogGroups.filter((command) => WORKSPACE_SECTIONS.has(command.id)),
    },
    {
      id: 'admin',
      label: t('menuAdmin'),
      entries: [
        ...dialogGroups.filter((command) => ADMIN_SECTIONS.has(command.id)),
        ...pick(ADMIN_PLACES),
        ...adminGroups,
      ],
    },
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
        menus.map<PaletteCommand>((section) => ({
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
