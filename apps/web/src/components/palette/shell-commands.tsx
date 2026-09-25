'use client';

import { InboxIcon, PanelLeftIcon, PanelRightIcon, Trash2Icon } from 'lucide-react';
import { type useTranslations } from 'next-intl';
import * as React from 'react';

import { keywordsOf, type PaletteCommand } from './palette-command';

const ICON = 'size-4 text-muted-foreground';

/**
 * The shell's own commands, for the palette (issue #115).
 *
 * Four things this application can do that, until now, existed only as a key
 * combination: a person who does not already know `Strg + E` had no way to find
 * out that capture exists, and `/hilfe` names the feature without being able to
 * start it. A palette whose name says "command" and that offers none is the
 * same gap from the other side.
 *
 * The trash is here too, and that is why `AppShell` owns the sheet now: it used
 * to live inside the page tree, so it could only be opened while the navigation
 * was on screen.
 */
export function shellCommands({
  hasWorkspace,
  sidebarOpen,
  contextOpen,
  onOpenCapture,
  onToggleSidebar,
  onToggleContext,
  onOpenTrash,
  t,
}: {
  hasWorkspace: boolean;
  sidebarOpen: boolean;
  contextOpen: boolean;
  onOpenCapture: () => void;
  onToggleSidebar: () => void;
  onToggleContext: () => void;
  onOpenTrash: () => void;
  t: ReturnType<typeof useTranslations<'shell.paletteCommands'>>;
}): PaletteCommand[] {
  const commands: PaletteCommand[] = [];

  if (hasWorkspace) {
    commands.push({
      id: 'command-capture',
      group: 'actions',
      idle: true,
      label: t('capture'),
      hint: t('captureHint'),
      icon: <InboxIcon className={ICON} />,
      keywords: keywordsOf(t('captureKeywords')),
      run: onOpenCapture,
    });
  }

  // Named by what the press does, not by the state it leads to: a menu entry
  // that says "Navigation ausblenden" is a promise, and one that says
  // "Navigation" leaves you to find out.
  //
  // Only inside a workspace, because outside one there is no page tree to show
  // or hide: the entry would name a thing that does not happen.
  if (hasWorkspace) {
    commands.push({
      id: 'command-sidebar',
      group: 'view',
      idle: true,
      label: sidebarOpen ? t('hideSidebar') : t('showSidebar'),
      hint: t('sidebarHint'),
      icon: <PanelLeftIcon className={ICON} />,
      keywords: keywordsOf(t('sidebarKeywords')),
      run: onToggleSidebar,
    });
  }

  commands.push({
    id: 'command-context',
    group: 'view',
    idle: true,
    label: contextOpen ? t('hideContext') : t('showContext'),
    hint: t('contextHint'),
    icon: <PanelRightIcon className={ICON} />,
    keywords: keywordsOf(t('contextKeywords')),
    run: onToggleContext,
  });

  if (hasWorkspace) {
    commands.push({
      id: 'command-trash',
      group: 'actions',
      idle: true,
      label: t('openTrash'),
      icon: <Trash2Icon className={ICON} />,
      keywords: keywordsOf(t('trashKeywords')),
      run: onOpenTrash,
    });
  }

  return commands;
}
