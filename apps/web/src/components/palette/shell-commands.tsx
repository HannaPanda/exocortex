'use client';

import {
  ActivityIcon,
  ExpandIcon,
  FocusIcon,
  InboxIcon,
  LinkIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SettingsIcon,
  SparklesIcon,
  Trash2Icon,
} from 'lucide-react';
import { type useTranslations } from 'next-intl';
import * as React from 'react';

import { type ContextTab } from '@/components/shell/context-panel';

import { keywordsOf, type PaletteCommand } from './palette-command';

const ICON = 'size-4 text-muted-foreground';

/**
 * Opening the context panel at one of its tabs. Only the assistant makes sense
 * off a page, and the panel drops its tab bar there (`ContextPanel`).
 */
const CONTEXT_TAB_COMMANDS: readonly {
  tab: ContextTab;
  key: 'Ai' | 'Properties' | 'Comments' | 'Backlinks' | 'Activity';
  icon: React.ComponentType<{ className?: string }>;
  needsPage: boolean;
}[] = [
  { tab: 'ai', key: 'Ai', icon: SparklesIcon, needsPage: false },
  { tab: 'comments', key: 'Comments', icon: MessageSquareIcon, needsPage: true },
  { tab: 'backlinks', key: 'Backlinks', icon: LinkIcon, needsPage: true },
  { tab: 'activity', key: 'Activity', icon: ActivityIcon, needsPage: true },
  { tab: 'properties', key: 'Properties', icon: SettingsIcon, needsPage: true },
];

export interface ShellCommandInput {
  hasWorkspace: boolean;
  hasDocument: boolean;
  sidebarOpen: boolean;
  contextOpen: boolean;
  onOpenCapture: () => void;
  onToggleSidebar: () => void;
  onToggleContext: () => void;
  onOpenContextTab: (tab: ContextTab) => void;
  onNewChat: () => void;
  onFocus: () => void;
  onOpenTrash: () => void;
  t: ReturnType<typeof useTranslations<'shell.paletteCommands'>>;
}

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
export function shellCommands(input: ShellCommandInput): PaletteCommand[] {
  const { hasWorkspace, sidebarOpen, contextOpen, t } = input;
  const commands: PaletteCommand[] = [];

  if (hasWorkspace) {
    commands.push({
      id: 'command-capture',
      group: 'create',
      idle: true,
      label: t('capture'),
      hint: t('captureHint'),
      icon: <InboxIcon className={ICON} />,
      keywords: keywordsOf(t('captureKeywords')),
      run: input.onOpenCapture,
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
      run: input.onToggleSidebar,
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
    run: input.onToggleContext,
  });

  if (hasWorkspace) {
    commands.push({
      id: 'command-trash',
      group: 'actions',
      idle: true,
      label: t('openTrash'),
      icon: <Trash2Icon className={ICON} />,
      keywords: keywordsOf(t('trashKeywords')),
      run: input.onOpenTrash,
    });
  }

  return [...commands, ...panelCommands(input)];
}

/**
 * A new chat, the context panel at a named tab, and the two ways to give the
 * page the whole screen.
 */
function panelCommands(input: ShellCommandInput): PaletteCommand[] {
  const { hasWorkspace, hasDocument, sidebarOpen, contextOpen, t } = input;
  const commands: PaletteCommand[] = [];

  // A conversation belongs to a workspace, so outside one there is nothing to
  // start it in.
  if (hasWorkspace) {
    commands.push({
      id: 'command-new-chat',
      group: 'create',
      label: t('newChat'),
      icon: <MessageSquarePlusIcon className={ICON} />,
      keywords: keywordsOf(t('newChatKeywords')),
      run: input.onNewChat,
    });
  }

  for (const entry of CONTEXT_TAB_COMMANDS) {
    if (entry.needsPage && !hasDocument) continue;
    commands.push({
      id: `command-context-${entry.tab}`,
      group: 'view',
      label: t(`context${entry.key}`),
      icon: <entry.icon className={ICON} />,
      keywords: keywordsOf(t(`context${entry.key}Keywords`)),
      run: () => input.onOpenContextTab(entry.tab),
    });
  }

  // Both panels away at once. Only offered while one of them is there,
  // because otherwise it would do nothing.
  if (sidebarOpen || contextOpen) {
    commands.push({
      id: 'command-focus',
      group: 'view',
      label: t('focus'),
      icon: <FocusIcon className={ICON} />,
      keywords: keywordsOf(t('focusKeywords')),
      run: input.onFocus,
    });
  }

  if (typeof document !== 'undefined' && document.fullscreenEnabled) {
    commands.push({
      id: 'command-fullscreen',
      group: 'view',
      label: t('fullscreen'),
      icon: <ExpandIcon className={ICON} />,
      keywords: keywordsOf(t('fullscreenKeywords')),
      run: () => {
        if (document.fullscreenElement === null) void document.documentElement.requestFullscreen();
        else void document.exitFullscreen();
      },
    });
  }

  return commands;
}
