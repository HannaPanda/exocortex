/**
 * The two layout panels' persisted preferences.
 *
 * Their own module because the shell is no longer the only thing that sets
 * them: `/chats` opens the context panel on its way to a conversation
 * (issue #69), and a second copy of the key or of the fallback width would be
 * a second, quietly diverging default.
 */

export const SIDEBAR_STORAGE_KEY = 'exocortex.sidebar';
export const CONTEXT_STORAGE_KEY = 'exocortex.context';

export interface PanelPreference {
  open: boolean;
  width: number;
}

export const SIDEBAR_DEFAULT: PanelPreference = { open: true, width: 272 };
export const CONTEXT_DEFAULT: PanelPreference = { open: true, width: 336 };

export function parsePanelPreference(raw: string): PanelPreference {
  const parsed = JSON.parse(raw) as Partial<PanelPreference>;
  return {
    open: typeof parsed.open === 'boolean' ? parsed.open : true,
    width: typeof parsed.width === 'number' ? parsed.width : 272,
  };
}
