import { describe, expect, it } from 'vitest';

import { navigationCommands } from './navigation-commands';
import { fillScreen, isLinkCommand, type PaletteContext, paletteMatcher } from './palette-command';
import { settingsCommands } from './settings-commands';

/** A translator that answers with the key, which is all these tests read. */
const echo = ((key: string) => key) as unknown as Parameters<typeof navigationCommands>[1];
const echoSettings = ((key: string) => key) as unknown as Parameters<typeof settingsCommands>[1];

const outside: PaletteContext = {
  workspaceId: null,
  documentId: null,
  role: 'user',
  workspaceRole: null,
};
const inside: PaletteContext = { ...outside, workspaceId: 'ws1', workspaceRole: 'MEMBER' };

const ids = (commands: readonly { id: string }[]): string[] => commands.map((c) => c.id);

describe('paletteMatcher', () => {
  it('matches every typed word somewhere, in any order', () => {
    const matches = paletteMatcher('ki einst');
    expect(matches('Einstellungen: KI', 'verwaltung')).toBe(true);
    expect(matches('Einstellungen: Suche', 'verwaltung')).toBe(false);
  });

  it('matches everything while nothing is typed', () => {
    expect(paletteMatcher('   ')('anything')).toBe(true);
  });
});

describe('navigationCommands', () => {
  it('offers no workspace place while no workspace is open', () => {
    const offered = ids(navigationCommands(outside, echo));
    expect(offered).toContain('navigate-chats');
    expect(offered).not.toContain('navigate-workspaceSettings');
    expect(offered).not.toContain('navigate-admin');
  });

  it('fills the open workspace into the address', () => {
    const settings = navigationCommands(inside, echo).find(
      (command) => command.id === 'navigate-workspaceSettings',
    );
    expect(settings !== undefined && isLinkCommand(settings) ? settings.href : null).toBe(
      '/arbeitsbereich/ws1/einstellungen',
    );
  });

  it('offers the Verwaltung only to an admin', () => {
    expect(ids(navigationCommands({ ...outside, role: 'admin' }, echo))).toContain(
      'navigate-adminModels',
    );
  });
});

describe('settingsCommands', () => {
  it('opens a deployment settings group by address, for an admin only', () => {
    const label = (group: string): string => group;
    expect(settingsCommands(inside, echoSettings, label).map((c) => c.id)).not.toContain(
      'settings-group-ai',
    );
    const ai = settingsCommands({ ...outside, role: 'admin' }, echoSettings, label).find(
      (command) => command.id === 'settings-group-ai',
    );
    expect(ai !== undefined && isLinkCommand(ai) ? ai.href : null).toBe(
      '/admin/einstellungen?gruppe=ai',
    );
  });

  it('offers the members tab only to somebody who may change them', () => {
    const label = (group: string): string => group;
    expect(ids(settingsCommands(inside, echoSettings, label))).not.toContain(
      'settings-workspace-members',
    );
    expect(
      ids(settingsCommands({ ...inside, workspaceRole: 'OWNER' }, echoSettings, label)),
    ).toContain('settings-workspace-members');
  });
});

describe('fillScreen', () => {
  it('leaves a screen without a workspace segment alone', () => {
    expect(fillScreen('/chats', 'ws1')).toBe('/chats');
  });
});
