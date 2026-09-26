import { describe, expect, it, vi } from 'vitest';

import { type DocumentDetail, type DocumentTreeNode, type Workspace } from '@exocortex/contracts';

import { pageBodyCommands, type PageBodyHandlers, pageMenuCommands } from './page-commands';
import {
  isMenuCommand,
  nestedCommands,
  nestedHint,
  type PaletteCommand,
  type PaletteContext,
  resolveMenus,
} from './palette-command';
import { shellCommands } from './shell-commands';
import { workspaceCommands } from './workspace-commands';

/** A translator that answers with the key, which is all these tests read. */
function echo<T>(): T {
  return ((key: string) => key) as unknown as T;
}

/** Only the fields the providers read; the rest of the detail is irrelevant here. */
function page(overrides: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    id: 'p1',
    type: 'PAGE',
    layout: 'narrow',
    overviewMode: 'off',
    coverAttachmentId: null,
    archivedAt: null,
    access: 'write',
    canShare: true,
    ...overrides,
  } as unknown as DocumentDetail;
}

const handlers = (): { current: PageBodyHandlers } => ({
  current: {
    ask: vi.fn(),
    setLayout: vi.fn(),
    setOverview: vi.fn(),
    openProperties: vi.fn(),
    createChild: vi.fn(),
    copyLink: vi.fn(),
    exportMarkdown: vi.fn(),
    openRender: vi.fn(),
    openImport: vi.fn(),
  },
});

const ids = (commands: readonly { id: string }[]): string[] => commands.map((c) => c.id);

/** The choices of the menu `id` among `commands`, or a failure naming it. */
function childrenOf(commands: readonly PaletteCommand[], id: string): readonly PaletteCommand[] {
  const menu = commands.find((command) => command.id === id);
  if (menu === undefined || !isMenuCommand(menu)) throw new Error(`${id} is not a menu`);
  return menu.children();
}

function run(commands: readonly PaletteCommand[], id: string): void {
  const command = commands.find((entry) => entry.id === id);
  if (command === undefined || !('run' in command)) throw new Error(`${id} does not run`);
  command.run();
}
const tPage = echo<Parameters<typeof pageBodyCommands>[3]>();

describe('pageBodyCommands', () => {
  it('offers a reader only what changes nothing', () => {
    const offered = ids(pageBodyCommands(page({ access: 'read' }), false, handlers(), tPage));
    expect(offered).toContain('page-copy-link');
    expect(offered).toContain('page-export');
    expect(offered).not.toContain('page-rename');
    expect(offered).not.toContain('page-create-child');
  });

  it('asks for the width in one menu and marks the one the page has', () => {
    const ref = handlers();
    const commands = pageBodyCommands(page({ layout: 'wide' }), true, ref, tPage);
    expect(ids(commands)).not.toContain('page-layout-wide');
    const widths = childrenOf(commands, 'page-layout');
    expect(ids(widths)).toEqual(['page-layout-narrow', 'page-layout-wide', 'page-layout-full']);
    expect(widths.find((entry) => entry.id === 'page-layout-wide')?.hint).toBe('current');
    run(widths, 'page-layout-wide');
    expect(ref.current.setLayout).not.toHaveBeenCalled();
    run(widths, 'page-layout-full');
    expect(ref.current.setLayout).toHaveBeenCalledWith('full');
  });

  it('puts making something beneath the page under "Erstellen"', () => {
    const child = pageBodyCommands(page(), true, handlers(), tPage).find(
      (command) => command.id === 'page-create-child',
    );
    expect(child?.group).toBe('create');
  });

  it('offers a file upload only where there is an editor', () => {
    const database = page({ type: 'COLLECTION' });
    expect(ids(pageBodyCommands(database, true, handlers(), tPage))).not.toContain(
      'page-upload-file',
    );
  });

  it('runs through the handlers the page keeps current', () => {
    const ref = handlers();
    const rename = pageBodyCommands(page(), true, ref, tPage).find((c) => c.id === 'page-rename');
    if (rename === undefined || !('run' in rename)) throw new Error('rename missing');
    rename.run();
    expect(ref.current.ask).toHaveBeenCalledWith('rename');
  });
});

function node(id: string, children: DocumentTreeNode[] = [], type = 'PAGE'): DocumentTreeNode {
  return {
    id,
    title: id,
    type,
    icon: null,
    iconColor: null,
    children,
  } as unknown as DocumentTreeNode;
}

describe('pageMenuCommands', () => {
  const menu = {
    current: {
      openTemplate: vi.fn(),
      openShare: vi.fn(),
      file: vi.fn(),
      moveTo: vi.fn(),
      archive: vi.fn(),
      restore: vi.fn(),
    },
  };
  const tree = [
    node('projekte', [node('exocortex', [node('architektur')]), node('p1', [node('under-p1')])]),
    node('db', [node('row')], 'COLLECTION'),
  ];
  const moving = page({ parentId: 'projekte' } as Partial<DocumentDetail>);

  it('walks the tree one level at a time, each level its own first answer', () => {
    const commands = pageMenuCommands(moving, false, menu, tPage, tree);
    const top = childrenOf(commands, 'page-move');
    // The root, and the one page; the database takes no pages.
    expect(ids(top)).toEqual(['page-move-root', 'page-move-into-projekte']);
    const projekte = childrenOf(top, 'page-move-into-projekte');
    // The page being moved and what hangs under it are no target.
    expect(ids(projekte)).toEqual(['page-move-to-projekte', 'page-move-into-exocortex']);
    expect(projekte[0]?.hint).toBe('current');
    run(childrenOf(projekte, 'page-move-into-exocortex'), 'page-move-to-architektur');
    expect(menu.current.moveTo).toHaveBeenCalledWith({
      parentId: 'architektur',
      title: 'architektur',
    });
  });

  it('finds a page deep in the tree by name, with the way to it', () => {
    const top = childrenOf(pageMenuCommands(moving, false, menu, tPage, tree), 'page-move');
    const found = nestedCommands(top, () => true).find(
      (nested) => nested.command.id === 'page-move-to-architektur',
    );
    expect(found === undefined ? null : nestedHint(found)).toBe('projekte / exocortex');
  });

  it('offers no tree move without the tree', () => {
    expect(ids(pageMenuCommands(moving, false, menu, tPage))).not.toContain('page-move');
  });

  it('offers only the way back on an archived page', () => {
    expect(ids(pageMenuCommands(page(), true, menu, tPage))).toEqual(['page-restore']);
  });

  it('offers sharing only where the page may be shared', () => {
    const offered = ids(pageMenuCommands(page({ canShare: false }), false, menu, tPage));
    expect(offered).not.toContain('page-share');
    expect(offered).toContain('page-archive');
  });
});

describe('workspaceCommands', () => {
  it('offers every workspace but the open one', () => {
    const context: PaletteContext = {
      workspaceId: 'a',
      documentId: null,
      role: 'user',
      workspaceRole: 'OWNER',
    };
    const workspaces = [
      { id: 'a', name: 'Eins' },
      { id: 'b', name: 'Zwei' },
    ] as unknown as Workspace[];
    const commands = workspaceCommands(
      context,
      workspaces,
      echo<Parameters<typeof workspaceCommands>[2]>(),
    );
    expect(ids(commands)).toEqual(['workspace-switch']);
    expect(ids(childrenOf(commands, 'workspace-switch'))).toEqual(['workspace-switch-b']);
  });

  it('offers no switch with nowhere else to go', () => {
    const context: PaletteContext = {
      workspaceId: 'a',
      documentId: null,
      role: 'user',
      workspaceRole: 'OWNER',
    };
    const only = [{ id: 'a', name: 'Eins' }] as unknown as Workspace[];
    expect(
      workspaceCommands(context, only, echo<Parameters<typeof workspaceCommands>[2]>()),
    ).toEqual([]);
  });
});

describe('shellCommands', () => {
  const base = {
    hasWorkspace: true,
    hasDocument: false,
    sidebarOpen: false,
    contextOpen: false,
    onOpenCapture: vi.fn(),
    onToggleSidebar: vi.fn(),
    onToggleContext: vi.fn(),
    onOpenContextTab: vi.fn(),
    onNewChat: vi.fn(),
    onFocus: vi.fn(),
    onOpenTrash: vi.fn(),
    t: echo<Parameters<typeof shellCommands>[0]['t']>(),
  };

  it('opens only the assistant off a page', () => {
    const tabs = ids(childrenOf(shellCommands(base), 'command-context-open'));
    expect(tabs).toEqual(['command-context-ai']);
  });

  it('opens the comments on a page', () => {
    const tabs = childrenOf(shellCommands({ ...base, hasDocument: true }), 'command-context-open');
    expect(ids(tabs)).toContain('command-context-comments');
  });

  it('offers focus only while a panel is there to hide', () => {
    expect(ids(shellCommands(base))).not.toContain('command-focus');
    expect(ids(shellCommands({ ...base, sidebarOpen: true }))).toContain('command-focus');
  });

  it('starts no chat outside a workspace', () => {
    expect(ids(shellCommands({ ...base, hasWorkspace: false }))).not.toContain('command-new-chat');
  });
});

describe('resolveMenus', () => {
  const inner: PaletteCommand = {
    id: 'inner',
    group: 'page',
    label: 'Inner',
    icon: null,
    keywords: [],
    children: () => [],
  };
  const outer: PaletteCommand = {
    id: 'outer',
    group: 'page',
    label: 'Outer',
    icon: null,
    keywords: [],
    children: () => [inner],
  };

  it('follows the ids it was given, outermost first', () => {
    expect(resolveMenus([outer], ['outer', 'inner']).map((menu) => menu.id)).toEqual([
      'outer',
      'inner',
    ]);
  });

  it('stops where an id has gone away', () => {
    expect(resolveMenus([outer], ['outer', 'gone', 'inner']).map((menu) => menu.id)).toEqual([
      'outer',
    ]);
  });
});
