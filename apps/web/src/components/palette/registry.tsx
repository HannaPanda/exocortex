'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type UserRole } from '@exocortex/contracts';

import { useSettingGroupLabel } from '@/components/settings/setting-copy';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { navigationCommands } from './navigation-commands';
import { type PaletteCommand, type PaletteContext } from './palette-command';
import { settingsCommands } from './settings-commands';

/**
 * Everything the command palette offers besides pages and saved searches.
 *
 * One provider per domain, each a plain function from the surface to the
 * commands that make sense on it (issue #148). A feature that brings its own
 * place, a setting group or an action adds a provider module beside these, or
 * entries to one of them; nothing here grows except the list below. The
 * shell's commands arrive ready-made, because the panels and dialogs they
 * open live in `AppShell` and the palette only lists them.
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
}: {
  workspaceId: string | null;
  documentId: string | null;
  role: UserRole;
  shell: readonly PaletteCommand[];
}): PaletteCommand[] {
  const tNavigation = useTranslations('shell.paletteCommands.navigation');
  const tSettings = useTranslations('shell.paletteCommands.settings');
  const groupLabel = useSettingGroupLabel();
  // Usually in the cache already: the workspace switcher and the settings
  // page ask for the same row.
  const detail = useWorkspaceDetail(workspaceId ?? undefined);
  const workspaceRole = detail.data?.role ?? null;

  return React.useMemo(() => {
    const context: PaletteContext = { workspaceId, documentId, role, workspaceRole };
    return [
      ...shell,
      ...navigationCommands(context, tNavigation),
      ...settingsCommands(context, tSettings, groupLabel),
    ];
  }, [documentId, groupLabel, role, shell, tNavigation, tSettings, workspaceId, workspaceRole]);
}
