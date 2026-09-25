/**
 * The addresses the settings commands open, apart from the commands.
 *
 * A module of its own and without `'use client'`, because the two settings
 * pages read these on the server: a constant exported from a client module
 * reaches a server component as a reference, not as the string.
 */

/** The query parameter `/admin/einstellungen` opens a group from. */
export const SETTING_GROUP_PARAM = 'gruppe';

/** The query parameter `/arbeitsbereich/:x/einstellungen` opens a tab from. */
export const WORKSPACE_TAB_PARAM = 'tab';

/**
 * The workspace settings' tabs, in their order on screen. English like every
 * identifier, although the path around them is German: an address is the
 * same in every locale (ADR-062), and these name tabs rather than places.
 */
export const WORKSPACE_SETTINGS_TABS = ['general', 'members', 'ai', 'overrides'] as const;
export type WorkspaceSettingsTab = (typeof WORKSPACE_SETTINGS_TABS)[number];

export function isWorkspaceSettingsTab(value: string): value is WorkspaceSettingsTab {
  return (WORKSPACE_SETTINGS_TABS as readonly string[]).includes(value);
}
