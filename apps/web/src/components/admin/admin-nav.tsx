'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { buttonVariants, cn } from '@exocortex/ui';

const NAV_ITEMS = [
  { href: '/admin', labelKey: 'overview' },
  { href: '/admin/einstellungen', labelKey: 'settings' },
  { href: '/admin/ki-modelle', labelKey: 'models' },
  { href: '/admin/nutzung', labelKey: 'usage' },
  { href: '/admin/nutzer', labelKey: 'users' },
  { href: '/admin/agenten', labelKey: 'agents' },
] as const;

/**
 * Horizontal navigation between the six admin tabs.
 *
 * The active area used to be painted in `--accent-solid`, which is the *hover*
 * tint: pointing at one area and standing in it looked the same, so after a
 * click there was nothing on screen that said where you had landed. Selection
 * is `--accent-strong` (tokens.css); the second signal it asks for is the text
 * stepping up to `--foreground`, the same pair the tabs use.
 */
export function AdminNav() {
  const pathname = usePathname();
  const t = useTranslations('admin.nav');

  return (
    <nav aria-label={t('label')} className="mt-6 flex flex-wrap gap-1 border-b border-border pb-2">
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              active && 'bg-accent-strong text-foreground',
            )}
          >
            {t(item.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
