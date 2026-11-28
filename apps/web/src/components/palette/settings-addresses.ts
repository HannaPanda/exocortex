/**
 * The addresses the settings commands open, apart from the commands.
 *
 * A module of its own and without `'use client'`, because the settings pages
 * read these on the server: a constant exported from a client module
 * reaches a server component as a reference, not as the string.
 */

/** The query parameter `/admin/einstellungen` opens a group from. */
export const SETTING_GROUP_PARAM = 'gruppe';

/**
 * The query parameter the old `/arbeitsbereich/:x/einstellungen` read its tab
 * from; its redirect still does, to open the dialog group the tab became.
 */
export const WORKSPACE_TAB_PARAM = 'tab';
