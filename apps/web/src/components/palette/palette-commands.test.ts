import { describe, expect, it } from 'vitest';

import { navigationCommands } from './navigation-commands';
import { fillScreen, isLinkCommand, type PaletteContext, paletteMatcher } from './palette-command';
import { settingsCommands, settingsSectionCommands } from './settings-commands';

/** A translator that answers with the key, which is all these tests read. */
const echo = ((key: string) => key) as unknown as Parameters<typeof navigationCommands>[1];
const echoSettings = ((key: string) => key) as unknown as Parameters<typeof settingsCommands>[1];
const echoSections = ((key: string) => key) as unknown as Parameters<
  typeof settingsSectionCommands
>[1];
const sectionHref = (section: string): string => `/x?einstellungen=${section}`;

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
    expect(offered).not.toContain('navigate-workspaceHome');
    expect(offered).not.toContain('navigate-admin');
  });

  it('fills the open workspace into the address', () => {
    const home = navigationCommands(inside, echo).find(
      (command) => command.id === 'navigate-workspaceHome',
    );
    expect(home !== undefined && isLinkCommand(home) ? home.href : null).toBe(
      '/arbeitsbereich/ws1',
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
});

describe('settingsSectionCommands', () => {
  it('offers each dialog group only to a role that may see it', () => {
    const offered = (context: PaletteContext): string[] =>
      ids(settingsSectionCommands(context, echoSections, sectionHref));
    expect(offered(outside)).toContain('settings-section-language');
    expect(offered(outside)).not.toContain('settings-section-workspace');
    expect(offered(inside)).toContain('settings-section-overrides');
    expect(offered(inside)).not.toContain('settings-section-members');
    expect(offered({ ...inside, workspaceRole: 'ADMIN' })).toContain('settings-section-members');
    expect(offered({ ...inside, workspaceRole: 'ADMIN' })).not.toContain('settings-section-tools');
    expect(offered({ ...inside, workspaceRole: 'OWNER' })).toContain('settings-section-tools');
    expect(offered(inside)).not.toContain('settings-section-admin');
    expect(offered({ ...outside, role: 'admin' })).toContain('settings-section-admin');
  });

  it('opens a group over the page being read', () => {
    const members = settingsSectionCommands(
      { ...inside, workspaceRole: 'OWNER' },
      echoSections,
      sectionHref,
    ).find((command) => command.id === 'settings-section-members');
    expect(members !== undefined && isLinkCommand(members) ? members.href : null).toBe(
      '/x?einstellungen=members',
    );
  });
});

describe('fillScreen', () => {
  it('leaves a screen without a workspace segment alone', () => {
    expect(fillScreen('/chats', 'ws1')).toBe('/chats');
  });
});
