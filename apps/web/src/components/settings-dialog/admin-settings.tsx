'use client';

import {
  BotIcon,
  ChartColumnIcon,
  CpuIcon,
  type LucideIcon,
  Settings2Icon,
  ShieldIcon,
  UsersIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { SectionRule } from '@exocortex/ui';

import { SETTING_GROUP_PARAM } from '@/components/palette/settings-addresses';
import { SETTING_GROUPS, useSettingGroupLabel } from '@/components/settings/setting-copy';

interface AdminPage {
  /** The place's name under `shell.paletteCommands.navigation`, one name for both. */
  key: 'admin' | 'adminSettings' | 'adminModels' | 'adminUsage' | 'adminUsers' | 'adminAgents';
  href: string;
  icon: LucideIcon;
}

const ADMIN_PAGES: readonly AdminPage[] = [
  { key: 'admin', href: '/admin', icon: ShieldIcon },
  { key: 'adminSettings', href: '/admin/einstellungen', icon: Settings2Icon },
  { key: 'adminModels', href: '/admin/ki-modelle', icon: CpuIcon },
  { key: 'adminUsage', href: '/admin/nutzung', icon: ChartColumnIcon },
  { key: 'adminUsers', href: '/admin/nutzer', icon: UsersIcon },
  { key: 'adminAgents', href: '/admin/agenten', icon: BotIcon },
];

const LINK_CLASS =
  'flex min-h-9 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-accent max-md:min-h-11';

/**
 * "Verwaltung" in the settings dialog (issue #279): the way into the
 * deployment's own screens, for an administrator.
 *
 * The screens stay pages. A hundred settings in fourteen groups with a save
 * button covering all of them, the model registry, the usage report and the
 * account list are tables and forms the width of a screen, and none of them
 * is something to lay over a page somebody is reading. What the dialog adds
 * is that nobody has to know where they are: every page by name, and every
 * group of the deployment's settings, each opening straight at itself.
 */
export function AdminSettings() {
  const tPlaces = useTranslations('shell.paletteCommands.navigation');
  const t = useTranslations('settings.dialog.admin');
  const groupLabel = useSettingGroupLabel();
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-labelledby="settings-admin-pages">
        <SectionRule as="h3" id="settings-admin-pages">
          {t('pages')}
        </SectionRule>
        <ul className="flex flex-col gap-0.5">
          {ADMIN_PAGES.map((page) => (
            <li key={page.key}>
              <Link href={page.href} className={LINK_CLASS}>
                <page.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{tPlaces(`${page.key}.label`)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="settings-admin-groups">
        <SectionRule as="h3" id="settings-admin-groups">
          {t('groups')}
        </SectionRule>
        <ul className="grid gap-0.5 sm:grid-cols-2">
          {SETTING_GROUPS.map((group) => (
            <li key={group}>
              <Link
                href={`/admin/einstellungen?${SETTING_GROUP_PARAM}=${group}`}
                className={LINK_CLASS}
                data-testid={`settings-admin-group-${group}`}
              >
                <Settings2Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{groupLabel(group)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
