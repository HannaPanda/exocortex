import {
  BellIcon,
  KeyIcon,
  LanguagesIcon,
  type LucideIcon,
  MessageSquareTextIcon,
  PenLineIcon,
  PlugIcon,
  Settings2Icon,
  ShieldIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  UsersIcon,
} from 'lucide-react';

import { type SettingsSectionId } from './sections';

/** The icon of each group, shared with the palette commands that open them. */
export const SETTINGS_SECTION_ICONS: Record<SettingsSectionId, LucideIcon> = {
  language: LanguagesIcon,
  editor: PenLineIcon,
  chat: MessageSquareTextIcon,
  notifications: BellIcon,
  connections: KeyIcon,
  workspace: Settings2Icon,
  members: UsersIcon,
  ai: SparklesIcon,
  tools: PlugIcon,
  overrides: SlidersHorizontalIcon,
  admin: ShieldIcon,
};
