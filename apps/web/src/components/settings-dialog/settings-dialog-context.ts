'use client';

import * as React from 'react';

import { type SettingsSectionId } from './sections';

/**
 * Opening the settings dialog from anywhere in the shell: the account menu,
 * the workspace's gear, a link inside a panel (issue #279).
 */
export interface SettingsDialogControl {
  /** Opens the dialog at `section`, or with none chosen for `''`. */
  open: (section: SettingsSectionId | '') => void;
  /** The address that opens `section` over the page being read. */
  href: (section: SettingsSectionId | '') => string;
}

export const SettingsDialogContext = React.createContext<SettingsDialogControl | null>(null);

export function useSettingsDialog(): SettingsDialogControl {
  const control = React.useContext(SettingsDialogContext);
  if (control === null) throw new Error('useSettingsDialog outside SettingsDialogProvider');
  return control;
}
