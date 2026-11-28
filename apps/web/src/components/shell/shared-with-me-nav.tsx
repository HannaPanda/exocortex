'use client';

import { LayoutGridIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { type IncomingShare } from '@exocortex/contracts';
import {
  cn,
  ErrorState,
  LoadingState,
  ScrollArea,
  SectionRule,
  TruncatedText,
} from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useIncomingShares } from '@/lib/api/share-queries';
import { useWorkspaces } from '@/lib/api/workspace-queries';

/** How many grants the navigation names before it points at the full list. */
const MAX_ENTRIES = 15;

/** Where the full list lives: the "Mit mir geteilt" tab of `/geteilt`. */
export const SHARED_WITH_ME_HREF = '/geteilt?ansicht=mit-mir';

/**
 * Pages other people shared with this account, in the navigation (issue #232).
 *
 * The reader is not a member of the workspace such a page lives in, so no page
 * tree will ever show it; until this section existed the only way there was
 * the account menu. Every entry says where it came from (who handed it over,
 * out of which workspace) and nothing about what surrounds it: the API answers
 * with the shared page itself, never with its parents, so there is no title
 * above the grant to leak.
 *
 * Inside a workspace the section is drawn only when there is something in it,
 * and stays silent while it loads or fails: it is a second way in, and an
 * empty heading under every tree would teach nothing. Standalone, on the
 * shared screens where it is the whole navigation, it says each state out
 * loud instead.
 *
 * A withdrawn grant leaves the list as soon as the server says so: the
 * realtime notice `exocortex.grants.changed` makes the shell read the list
 * again (`GrantsRefresh` in the shell), and returning to the tab does the same.
 */
export function SharedWithMeSection({ standalone = false }: { standalone?: boolean }) {
  const t = useTranslations('shell.sharedWithMe');
  const params = useParams<{ documentId?: string }>();
  const shares = useIncomingShares();

  if (shares.isPending) {
    return standalone ? <LoadingState variant="skeleton" rows={3} label={t('loading')} /> : null;
  }
  if (shares.isError) {
    return standalone ? (
      <ErrorState title={t('loadError')} onRetry={() => void shares.refetch()} />
    ) : null;
  }

  // A page in the trash is out of use, whoever looks at it from outside.
  const entries = shares.data.shares.filter((share) => share.document.archivedAt === null);
  if (entries.length === 0 && !standalone) return null;
  const shown = entries.slice(0, MAX_ENTRIES);

  return (
    <section
      className={cn(!standalone && 'mt-2 border-t border-border pt-2')}
      data-testid="shared-with-me-nav"
      aria-label={t('title')}
    >
      <SectionRule
        as="h2"
        className="px-2 py-1.5"
        trailing={entries.length === 0 ? undefined : entries.length}
        action={
          <Link
            href={SHARED_WITH_ME_HREF}
            aria-label={t('allLabel')}
            data-testid="shared-with-me-all"
            className="rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t('all')}
          </Link>
        }
      >
        {t('title')}
      </SectionRule>

      {entries.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground" data-testid="shared-with-me-empty">
          {t('empty')}
        </p>
      ) : (
        <ul aria-label={t('listLabel')} className="flex flex-col">
          {shown.map((share) => (
            <SharedWithMeEntry
              key={share.id}
              share={share}
              active={share.document.id === params.documentId}
            />
          ))}
        </ul>
      )}

      {entries.length > shown.length ? (
        <Link
          href={SHARED_WITH_ME_HREF}
          className="block rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          {t('more', { count: entries.length - shown.length })}
        </Link>
      ) : null}
    </section>
  );
}

/**
 * One shared page: its symbol and title on the row, its origin underneath.
 *
 * Drawn like a row of the page tree (same surface, weight and amber symbol
 * for "you are here", DESIGN.md "Navigation"), with the chevron's slot kept
 * free so the titles line up with the tree above them.
 */
function SharedWithMeEntry({ share, active }: { share: IncomingShare; active: boolean }) {
  const t = useTranslations('shell.sharedWithMe');
  const origin = t('origin', { name: share.sharedByName, workspace: share.workspaceName });
  return (
    <li data-testid={`shared-with-me-${share.document.id}`}>
      <Link
        href={`/geteilt/${share.document.id}`}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-start gap-1 rounded-md py-1 pr-1 pl-1 text-sm transition-colors',
          active
            ? 'bg-accent-strong font-medium text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <span aria-hidden className="size-5 shrink-0" />
        <span className="grid size-5 shrink-0 place-items-center">
          <DocumentIcon
            icon={share.document.icon}
            iconColor={share.document.iconColor}
            type={share.document.type}
            className={cn(
              'size-3.5 text-xs',
              active ? 'text-primary-text' : 'text-muted-foreground',
            )}
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <TruncatedText text={share.document.title} side="right" />
          <span className="truncate text-xs font-normal text-muted-foreground">{origin}</span>
        </span>
      </Link>
    </li>
  );
}

/**
 * The navigation of the shared screens (`/geteilt`, `/geteilt/<id>`).
 *
 * The reader is in nobody's workspace there, so there is no tree to show; what
 * they need instead is the way to the other pages shared with them, and the way
 * back into a workspace of their own (issue #232).
 */
export function SharedNavigation() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-1 py-2" clampContentWidth>
        <SharedWithMeSection standalone />
        <OwnWorkspaces />
      </ScrollArea>
    </div>
  );
}

function OwnWorkspaces() {
  const t = useTranslations('shell.sharedWithMe');
  const workspaces = useWorkspaces();
  const list = workspaces.data ?? [];

  return (
    <section
      className="mt-2 border-t border-border pt-2"
      data-testid="own-workspaces-nav"
      aria-label={t('workspacesTitle')}
    >
      <SectionRule as="h2" className="px-2 py-1.5">
        {t('workspacesTitle')}
      </SectionRule>
      {workspaces.isPending ? null : list.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">{t('workspacesEmpty')}</p>
      ) : (
        <ul aria-label={t('workspacesLabel')} className="flex flex-col">
          {list.map((workspace) => (
            <li key={workspace.id}>
              <Link
                href={`/arbeitsbereich/${workspace.id}`}
                data-testid={`own-workspace-${workspace.id}`}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <LayoutGridIcon className="size-3.5 shrink-0" />
                <TruncatedText text={workspace.name} side="right" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
