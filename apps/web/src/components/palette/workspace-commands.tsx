'use client';

import { ArrowRightLeftIcon } from 'lucide-react';
import { type useTranslations } from 'next-intl';
import * as React from 'react';

import { type Workspace } from '@exocortex/contracts';

import { keywordsOf, type PaletteCommand, type PaletteContext } from './palette-command';

/**
 * One command per other workspace, "Wechseln zu: Second Brain" (issue #148).
 *
 * Flat for now, in the order the switcher shows them (each person's own
 * order). Only asked for by name: with nothing typed a person with six
 * workspaces would see six rows above their recent pages.
 */
export function workspaceCommands(
  context: PaletteContext,
  workspaces: readonly Workspace[],
  t: ReturnType<typeof useTranslations<'shell.paletteCommands.workspace'>>,
): PaletteCommand[] {
  const keywords = keywordsOf(t('switchKeywords'));
  return workspaces
    .filter((workspace) => workspace.id !== context.workspaceId)
    .map((workspace) => ({
      id: `workspace-switch-${workspace.id}`,
      group: 'navigation',
      label: t('switch', { name: workspace.name }),
      icon: <ArrowRightLeftIcon className="size-4 text-muted-foreground" />,
      keywords,
      href: `/arbeitsbereich/${workspace.id}`,
    }));
}
