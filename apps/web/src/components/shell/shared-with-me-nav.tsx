'use client';

import { ChevronRightIcon, LayoutGridIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type DocumentSummary,
  type DocumentTreeNode,
  type IncomingShare,
} from '@exocortex/contracts';
import {
  cn,
  ErrorState,
  LoadingState,
  ScrollArea,
  SectionRule,
  TruncatedText,
} from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useDocument } from '@/lib/api/document-queries';
import { useIncomingShares, useSharedBranch } from '@/lib/api/share-queries';
import { useWorkspaces } from '@/lib/api/workspace-queries';
import { usePersistentState } from '@/lib/use-persistent-state';

import { EMPTY_EXPANDED, type ExpandedState, parseExpanded } from './page-tree-state';

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
  const activeId = params.documentId ?? null;
  const shares = useIncomingShares();
  const { expanded, toggle } = useSharedExpansion(activeId);

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
              activeId={activeId}
              expanded={expanded}
              toggle={toggle}
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
 * Which shared branches are unfolded, remembered across reloads like the page
 * tree's, plus the one rule the page tree has too: arriving at a page unfolds
 * the way to it and the page itself. The way is the open page's breadcrumb,
 * which for a recipient
 * starts at the shared page (the API cuts it at the grant), so unfolding it
 * opens nothing the reader could not open by hand. Once per arrival, so a
 * branch folded by hand stays folded while the page stays open.
 */
function useSharedExpansion(activeId: string | null): {
  expanded: ExpandedState;
  toggle: (documentId: string) => void;
} {
  const [expanded, setExpanded] = usePersistentState<ExpandedState>(
    'exocortex.shared.expanded',
    EMPTY_EXPANDED,
    parseExpanded,
  );
  const toggle = React.useCallback(
    (documentId: string) =>
      setExpanded({ ...expanded, [documentId]: expanded[documentId] !== true }),
    [expanded, setExpanded],
  );

  const open = useDocument(activeId ?? undefined);
  const unfoldedFor = React.useRef<string | null>(null);
  // The page itself belongs to the way too: opening a shared branch shows
  // what is in it. A string, so the effect sees a change of way rather than
  // a new array on every render.
  const way =
    open.data?.viaShare === true
      ? [...open.data.breadcrumb.map((entry) => entry.id), open.data.id].join(' ')
      : '';
  React.useEffect(() => {
    if (activeId === null || way === '' || unfoldedFor.current === activeId) return;
    unfoldedFor.current = activeId;
    const ids = way.split(' ');
    if (ids.every((id) => expanded[id] === true)) return;
    const next: Record<string, boolean> = { ...expanded };
    for (const id of ids) next[id] = true;
    setExpanded(next);
  }, [activeId, expanded, setExpanded, way]);

  return { expanded, toggle };
}

/**
 * One shared page: its symbol and title on the row, its origin underneath.
 *
 * Drawn like a row of the page tree (same surface, weight and amber symbol
 * for "you are here", DESIGN.md "Navigation"). A `SUBTREE` grant carries the
 * tree's chevron and unfolds into the pages below it (issue #327); a
 * `PAGE_ONLY` grant keeps the chevron's slot empty, so the titles still line
 * up, and has nothing to unfold.
 */
function SharedWithMeEntry({
  share,
  activeId,
  expanded,
  toggle,
}: {
  share: IncomingShare;
  activeId: string | null;
  expanded: ExpandedState;
  toggle: (documentId: string) => void;
}) {
  const t = useTranslations('shell.sharedWithMe');
  const origin = t('origin', { name: share.sharedByName, workspace: share.workspaceName });
  const document = share.document;
  const branch = share.scope === 'SUBTREE';
  const open = branch && expanded[document.id] === true;
  return (
    <li data-testid={`shared-with-me-${document.id}`}>
      <NavRow active={document.id === activeId} depth={0}>
        {branch ? (
          <Chevron title={document.title} open={open} onToggle={() => toggle(document.id)} />
        ) : (
          <span aria-hidden className="size-5 shrink-0" />
        )}
        <NavLink
          documentId={document.id}
          active={document.id === activeId}
          icon={document.icon}
          iconColor={document.iconColor}
          type={document.type}
          title={document.title}
          subtitle={origin}
        />
      </NavRow>
      {open ? (
        <SharedBranch
          workspaceId={share.workspaceId}
          root={document}
          activeId={activeId}
          expanded={expanded}
          toggle={toggle}
        />
      ) : null}
    </li>
  );
}

/**
 * The pages below a shared page, read as the reader and only while unfolded.
 *
 * The answer starts below the shared page and never above it: the server cuts
 * the tree at the grant, so this component has nothing to hide.
 */
function SharedBranch({
  workspaceId,
  root,
  activeId,
  expanded,
  toggle,
}: {
  workspaceId: string;
  root: DocumentSummary;
  activeId: string | null;
  expanded: ExpandedState;
  toggle: (documentId: string) => void;
}) {
  const t = useTranslations('shell.sharedWithMe');
  const branch = useSharedBranch(workspaceId, root.id, { enabled: true });
  const note = 'py-1 pr-1 text-xs text-muted-foreground';
  const indent = { paddingLeft: `${0.75 + 1.5}rem` };

  if (branch.isPending) {
    return (
      <p className={note} style={indent}>
        {t('branchLoading')}
      </p>
    );
  }
  if (branch.isError) {
    return (
      <p className={note} style={indent} role="alert">
        {t('branchError')}
      </p>
    );
  }
  if (branch.data.nodes.length === 0) {
    return (
      <p className={note} style={indent} data-testid={`shared-branch-empty-${root.id}`}>
        {t('branchEmpty')}
      </p>
    );
  }
  return (
    <ul aria-label={t('branchLabel', { title: root.title })} className="flex flex-col">
      {branch.data.nodes.map((node) => (
        <SharedBranchRow
          key={node.id}
          node={node}
          depth={1}
          activeId={activeId}
          expanded={expanded}
          toggle={toggle}
        />
      ))}
    </ul>
  );
}

function SharedBranchRow({
  node,
  depth,
  activeId,
  expanded,
  toggle,
}: {
  node: DocumentTreeNode;
  depth: number;
  activeId: string | null;
  expanded: ExpandedState;
  toggle: (documentId: string) => void;
}) {
  const t = useTranslations('shell.sharedWithMe');
  const hasChildren = node.children.length > 0;
  const open = hasChildren && expanded[node.id] === true;
  return (
    <li data-testid={`shared-branch-${node.id}`}>
      <NavRow active={node.id === activeId} depth={depth}>
        {hasChildren ? (
          <Chevron title={node.title} open={open} onToggle={() => toggle(node.id)} />
        ) : (
          <span aria-hidden className="size-5 shrink-0" />
        )}
        <NavLink
          documentId={node.id}
          active={node.id === activeId}
          icon={node.icon}
          iconColor={node.iconColor}
          type={node.type}
          title={node.title}
        />
      </NavRow>
      {open ? (
        <ul aria-label={t('branchLabel', { title: node.title })} className="flex flex-col">
          {node.children.map((child) => (
            <SharedBranchRow
              key={child.id}
              node={child}
              depth={depth + 1}
              activeId={activeId}
              expanded={expanded}
              toggle={toggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The row's surface: hover, "you are here", and the indent of its level. */
function NavRow({
  active,
  depth,
  children,
}: {
  active: boolean;
  depth: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-1 rounded-md py-1 pr-1 text-sm transition-colors',
        active
          ? 'bg-accent-strong font-medium text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
      style={{ paddingLeft: `${depth * 0.75 + 0.25}rem` }}
    >
      {children}
    </div>
  );
}

function Chevron({
  title,
  open,
  onToggle,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('shell.sharedWithMe');
  return (
    <button
      type="button"
      aria-label={open ? t('collapse', { title }) : t('expand', { title })}
      aria-expanded={open}
      onClick={onToggle}
      data-testid="shared-with-me-toggle"
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-transform hover:text-foreground',
        open && 'rotate-90',
      )}
    >
      <ChevronRightIcon className="size-3.5" />
    </button>
  );
}

function NavLink({
  documentId,
  active,
  icon,
  iconColor,
  type,
  title,
  subtitle,
}: Pick<DocumentSummary, 'icon' | 'iconColor' | 'type' | 'title'> & {
  documentId: string;
  active: boolean;
  subtitle?: string;
}) {
  return (
    <Link
      href={`/geteilt/${documentId}`}
      aria-current={active ? 'page' : undefined}
      className="flex min-w-0 flex-1 items-start gap-1 rounded-sm"
    >
      <span className="grid size-5 shrink-0 place-items-center">
        <DocumentIcon
          icon={icon}
          iconColor={iconColor}
          type={type}
          className={cn('size-3.5 text-xs', active ? 'text-primary-text' : 'text-muted-foreground')}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <TruncatedText text={title} side="right" />
        {subtitle === undefined ? null : (
          <span className="truncate text-xs font-normal text-muted-foreground">{subtitle}</span>
        )}
      </span>
    </Link>
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
