'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type UserRole } from '@exocortex/contracts';

import { useSettingGroupLabel } from '@/components/settings/setting-copy';
import { settingsAddress, type SettingsSectionId } from '@/components/settings-dialog/sections';
import { useWorkspaceDetail, useWorkspaces } from '@/lib/api/workspace-queries';

import { useChatScrollCommands } from './chat-scroll-commands';
import { usePaletteContributions } from './contributions';
import { useCreateCommands } from './create-commands';
import { navigationCommands } from './navigation-commands';
import { useOutlinePreferenceCommands } from './outline-preference-commands';
import { type PaletteCommand, type PaletteContext } from './palette-command';
import { settingsCommands, settingsMenu, settingsSectionCommands } from './settings-commands';
import { useTimeFormatCommands } from './time-format-commands';
import { workspaceCommands } from './workspace-commands';

/**
 * Everything the command palette offers besides pages and saved searches.
 *
 * One provider per domain, each a plain function from the surface to the
 * commands that make sense on it (issue #148). A feature that brings its own
 * place, a setting group or an action adds a provider module beside these, or
 * entries to one of them; nothing here grows except the list below. The
 * shell's commands arrive ready-made, because the panels and dialogs they
 * open live in `AppShell` and the palette only lists them. The open page's
 * and the open database's arrive the same way, through
 * `usePaletteContribution` in the component that owns their dialogs.
 *
 * What is enforced: every screen in `apps/web/src/app` is either opened by a
 * command in `navigation-commands.tsx` or excused in
 * `scripts/check-palette-coverage.mjs` with a reason, and every settings
 * group has search words. `docs/command-palette.md` has the recipe.
 */
export function usePaletteCommands({
  workspaceId,
  documentId,
  role,
  shell,
  open,
}: {
  workspaceId: string | null;
  documentId: string | null;
  role: UserRole;
  shell: readonly PaletteCommand[];
  /** Whether the palette is showing, for lists only worth loading then. */
  open: boolean;
}): PaletteCommand[] {
  const tNavigation = useTranslations('shell.paletteCommands.navigation');
  const tSettings = useTranslations('shell.paletteCommands.settings');
  const tSections = useTranslations('shell.paletteCommands.settingsSections');
  // A settings group opens over the page being read, so its address is this
  // one with the dialog's parameter added (issue #279).
  const pathname = usePathname();
  const searchString = useSearchParams().toString();
  const tWorkspace = useTranslations('shell.paletteCommands.workspace');
  const groupLabel = useSettingGroupLabel();
  const create = useCreateCommands(workspaceId, open);
  const chatScroll = useChatScrollCommands();
  const outline = useOutlinePreferenceCommands();
  const timeFormat = useTimeFormatCommands();
  const contributed = usePaletteContributions();
  const workspaces = useWorkspaces();
  // Usually in the cache already: the workspace switcher and the settings
  // page ask for the same row.
  const detail = useWorkspaceDetail(workspaceId ?? undefined);
  const workspaceRole = detail.data?.role ?? null;

  return React.useMemo(() => {
    const context: PaletteContext = { workspaceId, documentId, role, workspaceRole };
    const navigation = navigationCommands(context, tNavigation);
    const settings = settingsCommands(context, tSettings, groupLabel);
    const sections = settingsSectionCommands(context, tSections, (section: SettingsSectionId) =>
      settingsAddress({ pathname, search: searchString }, section),
    );
    return [
      ...contributed,
      ...create,
      ...shell,
      ...navigation,
      ...workspaceCommands(context, workspaces.data ?? [], tWorkspace),
      ...sections,
      ...settings,
      ...chatScroll,
      ...outline,
      ...timeFormat,
      ...settingsMenu(navigation, sections, settings, tSettings, groupLabel),
    ];
  }, [
    chatScroll,
    contributed,
    create,
    documentId,
    groupLabel,
    outline,
    pathname,
    role,
    searchString,
    shell,
    tNavigation,
    tSections,
    tSettings,
    tWorkspace,
    timeFormat,
    workspaceId,
    workspaceRole,
    workspaces.data,
  ]);
}
