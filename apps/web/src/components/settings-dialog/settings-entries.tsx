'use client';

import { type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { ChatSettings } from '@/components/settings/chat-settings';
import { ConnectionSettings } from '@/components/settings/connection-settings';
import { EditorSettings } from '@/components/settings/editor-settings';
import { LanguageSettings } from '@/components/settings/language-settings';
import { NotificationSettings } from '@/components/settings/notification-settings';

import { SETTINGS_SECTION_ICONS } from './section-icons';
import { SETTINGS_SECTIONS, type SettingsArea, type SettingsSectionId } from './sections';
import { useSettingsDialog } from './settings-dialog-context';

/** One group of the dialog, as the reader in front of it may see it. */
export interface SettingsEntry {
  id: SettingsSectionId;
  area: SettingsArea;
  label: string;
  intro: React.ReactNode;
  icon: LucideIcon;
  render: () => React.ReactNode;
}

/**
 * The panels each group shows. They are the components the old settings
 * pages rendered, without the page around them: one implementation, which
 * the dialog hangs in rather than copies (issue #279).
 */
const RENDER: Record<SettingsSectionId, () => React.ReactNode> = {
  language: () => <LanguageSettings />,
  editor: () => <EditorSettings />,
  chat: () => <ChatSettings />,
  notifications: () => <NotificationSettings />,
  connections: () => <ConnectionSettings />,
};

/**
 * The groups this reader may open, in the navigation's order. A group the
 * reader's role does not reach is left out rather than shown and refused,
 * the way the workspace settings left out a tab.
 */
export function useSettingsEntries(): SettingsEntry[] {
  const t = useTranslations('settings.dialog.sections');
  const { href } = useSettingsDialog();
  const notificationsHref = href('notifications');

  return React.useMemo(
    () =>
      SETTINGS_SECTIONS.map((section) => ({
        id: section.id,
        area: section.area,
        label: t(`${section.id}.label`),
        intro: t.rich(`${section.id}.intro`, {
          // Only "Verbindungen" points somewhere: to the group beside it, so
          // the link switches groups instead of leaving the dialog.
          link: (chunks) => (
            <Link href={notificationsHref} replace scroll={false} className="underline">
              {chunks}
            </Link>
          ),
        }),
        icon: SETTINGS_SECTION_ICONS[section.id],
        render: RENDER[section.id],
      })),
    [notificationsHref, t],
  );
}
