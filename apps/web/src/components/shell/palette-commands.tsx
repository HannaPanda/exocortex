'use client';

import { InboxIcon, PanelLeftIcon, PanelRightIcon, Trash2Icon } from 'lucide-react';
import * as React from 'react';

/** One thing the shell can do, offered by name in the command palette. */
export interface PaletteCommand {
  id: string;
  label: string;
  /** The keystroke that does the same thing, where there is one. */
  hint?: string;
  icon: React.ReactNode;
  /** Words somebody might type instead of the label. */
  keywords: readonly string[];
  run: () => void;
}

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
}: {
  hasWorkspace: boolean;
  sidebarOpen: boolean;
  contextOpen: boolean;
  onOpenCapture: () => void;
  onToggleSidebar: () => void;
  onToggleContext: () => void;
  onOpenTrash: () => void;
}): PaletteCommand[] {
  const commands: PaletteCommand[] = [];

  if (hasWorkspace) {
    commands.push({
      id: 'command-capture',
      label: 'Etwas erfassen',
      hint: 'Strg + E',
      icon: <InboxIcon className={ICON} />,
      keywords: ['eingang', 'notiz', 'schnell', 'inbox'],
      run: onOpenCapture,
    });
  }

  // Named by what the press does, not by the state it leads to: a menu entry
  // that says "Navigation ausblenden" is a promise, and one that says
  // "Navigation" leaves you to find out.
  commands.push({
    id: 'command-sidebar',
    label: sidebarOpen ? 'Navigation ausblenden' : 'Navigation einblenden',
    hint: 'Strg + B',
    icon: <PanelLeftIcon className={ICON} />,
    keywords: ['seitenleiste', 'seitenbaum', 'sidebar'],
    run: onToggleSidebar,
  });

  commands.push({
    id: 'command-context',
    label: contextOpen ? 'Kontextbereich ausblenden' : 'Kontextbereich einblenden',
    hint: 'Strg + .',
    icon: <PanelRightIcon className={ICON} />,
    keywords: ['ki', 'kommentare', 'panel', 'verweise'],
    run: onToggleContext,
  });

  if (hasWorkspace) {
    commands.push({
      id: 'command-trash',
      label: 'Papierkorb öffnen',
      icon: <Trash2Icon className={ICON} />,
      keywords: ['gelöscht', 'archiv', 'wiederherstellen'],
      run: onOpenTrash,
    });
  }

  return commands;
}
