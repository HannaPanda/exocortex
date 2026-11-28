import {
  BellIcon,
  KeyIcon,
  LanguagesIcon,
  type LucideIcon,
  PenLineIcon,
  SparklesIcon,
} from 'lucide-react';

import { type SettingsSectionId } from './sections';

/** The icon of each group, shared with the palette commands that open them. */
export const SETTINGS_SECTION_ICONS: Record<SettingsSectionId, LucideIcon> = {
  language: LanguagesIcon,
  editor: PenLineIcon,
  chat: SparklesIcon,
  notifications: BellIcon,
  connections: KeyIcon,
};
