import { describe, expect, it } from 'vitest';

import {
  accountSettingsRedirect,
  sectionReaches,
  SETTINGS_SECTIONS,
  settingsAddress,
  settingsRequestOf,
  workspaceSettingsRedirect,
} from './sections';

describe('settingsRequestOf', () => {
  it('is closed without the parameter', () => {
    expect(settingsRequestOf(new URLSearchParams('q=x'))).toEqual({ open: false });
  });

  it('names a known group, and no group for anything else', () => {
    expect(settingsRequestOf(new URLSearchParams('einstellungen=editor'))).toEqual({
      open: true,
      section: 'editor',
    });
    expect(settingsRequestOf(new URLSearchParams('einstellungen='))).toEqual({
      open: true,
      section: null,
    });
    expect(settingsRequestOf(new URLSearchParams('einstellungen=nope'))).toEqual({
      open: true,
      section: null,
    });
  });
});

describe('settingsAddress', () => {
  const location = { pathname: '/arbeitsbereich/ws1/seite/p1', search: '?p=row1', hash: '#h' };

  it('adds the group and keeps every other parameter and the fragment', () => {
    expect(settingsAddress(location, 'chat')).toBe(
      '/arbeitsbereich/ws1/seite/p1?p=row1&einstellungen=chat#h',
    );
  });

  it('opens with no group chosen for an empty string', () => {
    expect(settingsAddress({ pathname: '/chats', search: '' }, '')).toBe('/chats?einstellungen=');
  });

  it('removes the dialog and nothing else for null', () => {
    expect(
      settingsAddress({ pathname: '/chats', search: '?einstellungen=language&q=1' }, null),
    ).toBe('/chats?q=1');
    expect(settingsAddress({ pathname: '/chats', search: '?einstellungen=language' }, null)).toBe(
      '/chats',
    );
  });
});

describe('SETTINGS_SECTIONS', () => {
  it('has unique ids, each a single lowercase word usable as an address', () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
  });

  it('sends an old account page to a workspace with the group open', () => {
    expect(accountSettingsRedirect('language')).toBe('/arbeitsbereich?einstellungen=language');
  });

  it('sends an old workspace tab to the group it became', () => {
    expect(workspaceSettingsRedirect('ws1', 'general')).toBe(
      '/arbeitsbereich/ws1?einstellungen=workspace',
    );
    expect(workspaceSettingsRedirect('ws1', 'tools')).toBe(
      '/arbeitsbereich/ws1?einstellungen=tools',
    );
    expect(workspaceSettingsRedirect('ws1', null)).toBe(
      '/arbeitsbereich/ws1?einstellungen=workspace',
    );
    expect(workspaceSettingsRedirect('ws1', 'nonsense')).toBe(
      '/arbeitsbereich/ws1?einstellungen=workspace',
    );
  });
});

describe('sectionReaches', () => {
  const member = { admin: false, workspaceRole: 'MEMBER' };
  it('holds the workspace groups to the bars the API has', () => {
    expect(sectionReaches('workspaceMember', member)).toBe(true);
    expect(sectionReaches('workspaceAdmin', member)).toBe(false);
    expect(sectionReaches('workspaceAdmin', { ...member, workspaceRole: 'ADMIN' })).toBe(true);
    expect(sectionReaches('workspaceOwner', { ...member, workspaceRole: 'ADMIN' })).toBe(false);
    expect(sectionReaches('workspaceOwner', { ...member, workspaceRole: 'OWNER' })).toBe(true);
  });

  it('shows no workspace group without a workspace and the Verwaltung to an admin only', () => {
    expect(sectionReaches('workspaceMember', { admin: true, workspaceRole: null })).toBe(false);
    expect(sectionReaches('admin', member)).toBe(false);
    expect(sectionReaches('admin', { ...member, admin: true })).toBe(true);
  });
});
