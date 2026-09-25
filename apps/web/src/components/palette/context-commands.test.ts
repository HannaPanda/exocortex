import { describe, expect, it, vi } from 'vitest';

import { type DocumentDetail, type Workspace } from '@exocortex/contracts';

import { pageBodyCommands, type PageBodyHandlers, pageMenuCommands } from './page-commands';
import { type PaletteContext } from './palette-command';
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
const tPage = echo<Parameters<typeof pageBodyCommands>[3]>();

describe('pageBodyCommands', () => {
  it('offers a reader only what changes nothing', () => {
    const offered = ids(pageBodyCommands(page({ access: 'read' }), false, handlers(), tPage));
    expect(offered).toContain('page-copy-link');
    expect(offered).toContain('page-export');
    expect(offered).not.toContain('page-rename');
    expect(offered).not.toContain('page-create-child');
  });

  it('offers the two widths the page does not have', () => {
    const offered = ids(pageBodyCommands(page({ layout: 'wide' }), true, handlers(), tPage));
    expect(offered).toContain('page-layout-narrow');
    expect(offered).toContain('page-layout-full');
    expect(offered).not.toContain('page-layout-wide');
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

describe('pageMenuCommands', () => {
  const menu = {
    current: {
      openTemplate: vi.fn(),
      openShare: vi.fn(),
      file: vi.fn(),
      archive: vi.fn(),
      restore: vi.fn(),
    },
  };

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
    expect(ids(commands)).toEqual(['workspace-switch-b']);
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
    const offered = ids(shellCommands(base));
    expect(offered).toContain('command-context-ai');
    expect(offered).not.toContain('command-context-comments');
  });

  it('opens the comments on a page', () => {
    expect(ids(shellCommands({ ...base, hasDocument: true }))).toContain(
      'command-context-comments',
    );
  });

  it('offers focus only while a panel is there to hide', () => {
    expect(ids(shellCommands(base))).not.toContain('command-focus');
    expect(ids(shellCommands({ ...base, sidebarOpen: true }))).toContain('command-focus');
  });

  it('starts no chat outside a workspace', () => {
    expect(ids(shellCommands({ ...base, hasWorkspace: false }))).not.toContain('command-new-chat');
  });
});
