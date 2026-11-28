'use client';

import {
  BotIcon,
  ChartColumnIcon,
  CpuIcon,
  FlaskConicalIcon,
  LayoutTemplateIcon,
  type LucideIcon,
  OrbitIcon,
  Settings2Icon,
  Share2Icon,
  UsersIcon,
  WaypointsIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { SETTING_KEYS, type SettingKey, WORKSPACE_SETTING_KEYS } from '@exocortex/contracts';

import { keywordsOf } from '@/components/palette/palette-command';
import { SETTING_GROUP_PARAM } from '@/components/palette/settings-addresses';
import { SETTING_GROUPS, useSettingGroupLabel } from '@/components/settings/setting-copy';
import { groupOf } from '@/components/settings/setting-row';

import { type SettingsSectionId } from './sections';
import { type SettingsEntry } from './settings-entries';
import { type SettingsSearchDoc } from './settings-search';

/** What a hit of the dialog's search opens. */
export type SettingsSearchTarget =
  { kind: 'section'; id: SettingsSectionId } | { kind: 'page'; href: string };

export interface DialogSearchDoc extends SettingsSearchDoc {
  target: SettingsSearchTarget;
  icon: LucideIcon;
  /** Where the hit lives, when that is not the dialog: "Verwaltung", "Eigene Seite". */
  hint: string | null;
}

/** A page of its own the search names, by its palette place (one name for both). */
interface PageDoc {
  place:
    | 'knowledgeMap'
    | 'automations'
    | 'workflows'
    | 'agentProfiles'
    | 'evals'
    | 'templates'
    | 'workspaceShares'
    | 'adminModels'
    | 'adminUsage'
    | 'adminUsers'
    | 'adminAgents';
  icon: LucideIcon;
  /** Below the workspace, or the deployment's own. */
  path: (workspaceId: string) => string;
  admin?: true;
}

const PAGE_DOCS: readonly PageDoc[] = [
  { place: 'knowledgeMap', icon: OrbitIcon, path: (id) => `/arbeitsbereich/${id}/karte` },
  { place: 'automations', icon: WorkflowIcon, path: (id) => `/arbeitsbereich/${id}/automationen` },
  { place: 'workflows', icon: WaypointsIcon, path: (id) => `/arbeitsbereich/${id}/workflows` },
  { place: 'agentProfiles', icon: BotIcon, path: (id) => `/arbeitsbereich/${id}/agentenprofile` },
  { place: 'evals', icon: FlaskConicalIcon, path: (id) => `/arbeitsbereich/${id}/evals` },
  { place: 'templates', icon: LayoutTemplateIcon, path: (id) => `/arbeitsbereich/${id}/vorlagen` },
  { place: 'workspaceShares', icon: Share2Icon, path: (id) => `/arbeitsbereich/${id}/freigaben` },
  { place: 'adminModels', icon: CpuIcon, path: () => '/admin/ki-modelle', admin: true },
  { place: 'adminUsage', icon: ChartColumnIcon, path: () => '/admin/nutzung', admin: true },
  { place: 'adminUsers', icon: UsersIcon, path: () => '/admin/nutzer', admin: true },
  { place: 'adminAgents', icon: BotIcon, path: () => '/admin/agenten', admin: true },
];

/**
 * Everything the dialog's search looks through, for the reader in front of
 * it: the groups they see, with the names of the single settings inside where
 * the dialog shows them as rows; for an administrator every group of the
 * deployment's settings, each with its settings; and the pages that stay
 * pages, so that a search for "Sterne" finds the map's appearance where it
 * is set, on the map.
 *
 * Every name and every search word is read from the catalogue the palette
 * reads, so the two can never disagree about what a word finds.
 */
export function useSettingsSearchDocs({
  entries,
  workspaceId,
  admin,
}: {
  entries: readonly SettingsEntry[];
  workspaceId: string | null;
  admin: boolean;
}): DialogSearchDoc[] {
  const tSections = useTranslations('shell.paletteCommands.settingsSections');
  const tPlaces = useTranslations('shell.paletteCommands.navigation');
  const tSettings = useTranslations('shell.paletteCommands.settings');
  const tKeys = useTranslations('settings.keys');
  const t = useTranslations('settings.dialog.search');
  const groupLabel = useSettingGroupLabel();

  return React.useMemo(() => {
    const label = (key: SettingKey): string => tKeys(`${key}.label`);
    const docs: DialogSearchDoc[] = entries.map((entry) => ({
      key: `section-${entry.id}`,
      label: entry.label,
      keywords: [tSections(`${entry.id}.label`), ...keywordsOf(tSections(`${entry.id}.keywords`))],
      options: entry.id === 'overrides' ? WORKSPACE_SETTING_KEYS.map(label) : [],
      target: { kind: 'section', id: entry.id },
      icon: entry.icon,
      hint: null,
    }));
    if (admin) {
      for (const group of SETTING_GROUPS) {
        docs.push({
          key: `admin-${group}`,
          label: groupLabel(group),
          keywords: [
            ...keywordsOf(tSettings('adminKeywords')),
            ...keywordsOf(tSettings(`groups.${group}`)),
          ],
          options: SETTING_KEYS.filter((key) => groupOf(key) === group).map(label),
          target: { kind: 'page', href: `/admin/einstellungen?${SETTING_GROUP_PARAM}=${group}` },
          icon: Settings2Icon,
          hint: t('adminHint'),
        });
      }
    }
    for (const page of PAGE_DOCS) {
      if (page.admin === true ? !admin : workspaceId === null) continue;
      docs.push({
        key: `page-${page.place}`,
        label: tPlaces(`${page.place}.label`),
        keywords: keywordsOf(tPlaces(`${page.place}.keywords`)),
        options: [],
        target: { kind: 'page', href: page.path(workspaceId ?? '') },
        icon: page.icon,
        hint: t('pageHint'),
      });
    }
    return docs;
  }, [admin, entries, groupLabel, t, tKeys, tPlaces, tSections, tSettings, workspaceId]);
}
