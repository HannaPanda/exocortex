'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { buttonVariants, cn } from '@exocortex/ui';

const NAV_ITEMS = [
  { href: '/admin', label: 'Übersicht' },
  { href: '/admin/einstellungen', label: 'Einstellungen' },
  { href: '/admin/ki-modelle', label: 'KI-Modelle' },
  { href: '/admin/nutzung', label: 'Nutzung' },
  { href: '/admin/nutzer', label: 'Nutzer' },
] as const;

/** Horizontal navigation between the five admin tabs. */
export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Verwaltungsbereiche"
      className="mt-6 flex flex-wrap gap-1 border-b border-border pb-2"
    >
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              active && 'bg-accent text-accent-foreground',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
