'use client';

import { Share2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type IncomingShare } from '@exocortex/contracts';

import { DocumentIcon } from '@/components/document/document-icon';
import { SHARED_WITH_ME_HREF } from '@/components/shell/shared-with-me-nav';
import { useIncomingShares } from '@/lib/api/share-queries';

import { keywordsOf, type PaletteCommand } from './palette-command';

const ICON = 'size-4 text-muted-foreground';

/**
 * "Mit mir geteilt öffnen → <Seite>" (issue #232).
 *
 * The same pages as the section in the navigation, one Enter away from any
 * screen. A menu rather than one command per page, because every one of them
 * is the same choice; searchable, because there are a handful and their titles
 * are what somebody types. The first choice is the full list, which is also
 * the only choice an empty menu has.
 */
export function sharedWithMeCommands(
  shares: readonly IncomingShare[],
  t: ReturnType<typeof useTranslations<'shell.paletteCommands.sharedWithMe'>>,
): PaletteCommand[] {
  const keywords = keywordsOf(t('keywords'));
  const pages: PaletteCommand[] = shares
    .filter((share) => share.document.archivedAt === null)
    .map((share) => ({
      id: `shared-with-me-${share.document.id}`,
      group: 'navigation',
      label: share.document.title,
      hint: t('origin', { name: share.sharedByName, workspace: share.workspaceName }),
      icon: (
        <DocumentIcon
          icon={share.document.icon}
          iconColor={share.document.iconColor}
          type={share.document.type}
          className={ICON}
        />
      ),
      keywords,
      href: `/geteilt/${share.document.id}`,
    }));
  return [
    {
      id: 'shared-with-me',
      group: 'navigation',
      label: t('menu'),
      placeholder: t('placeholder'),
      empty: t('empty'),
      icon: <Share2Icon className={ICON} />,
      keywords,
      searchable: true,
      children: () => [
        {
          id: 'shared-with-me-all',
          group: 'navigation',
          label: t('all'),
          icon: <Share2Icon className={ICON} />,
          keywords,
          href: SHARED_WITH_ME_HREF,
        },
        ...pages,
      ],
    },
  ];
}

/** The commands above, loaded only while the palette is showing. */
export function useSharedWithMeCommands(open: boolean): PaletteCommand[] {
  const t = useTranslations('shell.paletteCommands.sharedWithMe');
  const shares = useIncomingShares({ enabled: open });
  const list = shares.data?.shares;
  return React.useMemo(() => sharedWithMeCommands(list ?? [], t), [list, t]);
}
