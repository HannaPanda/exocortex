'use client';

import { ArrowRightLeftIcon } from 'lucide-react';
import { type useTranslations } from 'next-intl';
import * as React from 'react';

import { type Workspace } from '@exocortex/contracts';

import { keywordsOf, type PaletteCommand, type PaletteContext } from './palette-command';

/**
 * "Arbeitsbereich wechseln → Second Brain" (issue #148).
 *
 * One menu, its choices in the order the switcher shows them (each person's
 * own order), and searchable: typing the workspace's name finds it from the
 * top, with the menu as the hint. Only offered when there is somewhere else
 * to go.
 */
export function workspaceCommands(
  context: PaletteContext,
  workspaces: readonly Workspace[],
  t: ReturnType<typeof useTranslations<'shell.paletteCommands.workspace'>>,
): PaletteCommand[] {
  const keywords = keywordsOf(t('switchKeywords'));
  const others: PaletteCommand[] = workspaces
    .filter((workspace) => workspace.id !== context.workspaceId)
    .map((workspace) => ({
      id: `workspace-switch-${workspace.id}`,
      group: 'navigation',
      label: workspace.name,
      icon: <ArrowRightLeftIcon className="size-4 text-muted-foreground" />,
      keywords,
      href: `/arbeitsbereich/${workspace.id}`,
    }));
  if (others.length === 0) return [];
  return [
    {
      id: 'workspace-switch',
      group: 'navigation',
      label: t('menu'),
      placeholder: t('menuPlaceholder'),
      icon: <ArrowRightLeftIcon className="size-4 text-muted-foreground" />,
      keywords,
      searchable: true,
      children: () => others,
    },
  ];
}
