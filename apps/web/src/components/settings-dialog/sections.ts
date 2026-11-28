/**
 * The groups of the settings dialog, and the address that opens one (issue #279).
 *
 * One list, read by everything that has to agree on it: the dialog draws its
 * navigation from it, the palette offers one command per entry, the redirects
 * of the old settings pages map onto it, and `check-palette-coverage.mjs`
 * reads the ids out of this file to demand a name and search words for each.
 * A new setting is placed in one of these groups, or a new group is added
 * here; it never gets a page of its own (docs/admin.md, "Where a new setting
 * goes").
 *
 * No `'use client'`: the redirect pages read these on the server, and a
 * constant exported from a client module arrives there as a reference rather
 * than the value.
 */

/** The query parameter the dialog opens from: `?einstellungen=language`. */
export const SETTINGS_PARAM = 'einstellungen';

export type SettingsArea = 'account' | 'workspace' | 'admin';

/**
 * Who sees a group. `everyone` and `admin` are the account's own role; the
 * workspace levels are the reader's role in the workspace the dialog shows,
 * the same bars the API holds the routes behind.
 */
export type SettingsAudience =
  'everyone' | 'workspaceMember' | 'workspaceAdmin' | 'workspaceOwner' | 'admin';

export interface SettingsSection {
  /**
   * English and stable, because it is an address: the same in every locale
   * (ADR-062), in bookmarks, in a link somebody pasted. It is also the key of
   * the group's words in the catalogue.
   */
  readonly id: string;
  readonly area: SettingsArea;
  readonly audience: SettingsAudience;
}

/** In the order the navigation shows them. */
export const SETTINGS_SECTIONS = [
  { id: 'language', area: 'account', audience: 'everyone' },
  { id: 'editor', area: 'account', audience: 'everyone' },
  { id: 'chat', area: 'account', audience: 'everyone' },
  { id: 'notifications', area: 'account', audience: 'everyone' },
  { id: 'connections', area: 'account', audience: 'everyone' },
] as const satisfies readonly SettingsSection[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

export const SETTINGS_AREAS: readonly SettingsArea[] = ['account', 'workspace', 'admin'];

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

/**
 * What the dialog was asked to show: a group, the open dialog with none
 * chosen yet (`?einstellungen=`, the phone's list), or nothing.
 */
export type SettingsRequest = { open: false } | { open: true; section: SettingsSectionId | null };

export function settingsRequestOf(search: {
  get: (name: string) => string | null;
}): SettingsRequest {
  const value = search.get(SETTINGS_PARAM);
  if (value === null) return { open: false };
  return { open: true, section: isSettingsSectionId(value) ? value : null };
}

/**
 * `location` with the dialog at `section`, or without it for `null`; every
 * other parameter and the fragment stay. An empty string opens the dialog
 * with no group chosen.
 */
export function settingsAddress(
  location: { pathname: string; search: string; hash?: string },
  section: SettingsSectionId | '' | null,
): string {
  const params = new URLSearchParams(location.search);
  if (section === null) params.delete(SETTINGS_PARAM);
  else params.set(SETTINGS_PARAM, section);
  const query = params.toString();
  return `${location.pathname}${query === '' ? '' : `?${query}`}${location.hash ?? ''}`;
}

/**
 * Where the old settings pages send a browser that still knows them. They
 * are not inside a workspace, so they land on `/arbeitsbereich`, which opens
 * the first one and carries the parameter along.
 */
export function accountSettingsRedirect(section: SettingsSectionId): string {
  return `/arbeitsbereich?${SETTINGS_PARAM}=${section}`;
}
