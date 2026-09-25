'use client';

import { type NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper } from '@tiptap/react';
import { PencilIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentLinkMatch } from '@exocortex/contracts';
import {
  pageLinkDocumentId,
  type PageLinkResolution,
  pageLinkTitle,
  resolvePageLinkTarget,
} from '@exocortex/editor';
import { Badge, Button, LoadingState } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { usePageLinkResolution } from '@/lib/api/page-link-queries';

import { FollowLinkContext } from './follow-link-context';
import { PageLinkPromptContext } from './page-link-context';

interface PageLinkNodeViewProps extends NodeViewProps {
  workspaceId: string;
}

/** Layout of the clickable part of the card, shared by the anchor and the button. */
const TARGET_CLASS = 'flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left';

/** Each way a reference can fail to name a page; the words are in `editor.pageLink.unresolved`. */
type UnresolvedReason = 'empty' | 'deleted' | 'missing';

/**
 * React node view for the `pageLink` node (`packages/editor/src/page-link.ts`).
 *
 * Shows what a plain anchor never could: the target's icon, its current title
 * (which is not necessarily the one stored in the document — the reference is
 * an identity, so a rename shows up here immediately), whether several pages
 * carry the title, and whether the reference resolves to nothing at all.
 * Resolution to a document is application knowledge, not schema knowledge,
 * which is why this lives here and not in `packages/editor` (see
 * `docs/editor-extensions.md`); the *rule* it follows is the pure
 * `resolvePageLinkTarget` from that package.
 *
 * An unresolved reference is deliberately not an error state: it names a page
 * that does not exist yet and offers to create it, which is what makes typing
 * a title a way of working rather than a mistake.
 *
 * Deliberately **no** `stopPropagation` as a guard against the editor-wide
 * click handler in `collaborative-editor.tsx`: ProseMirror listens on
 * `view.dom`, React listens on its own root above that, so React's
 * `stopPropagation` runs too late to matter. The actual guard is the
 * `[data-page-link]` check in that handler's `followFromEvent`.
 */
export function PageLinkNodeView({
  node,
  editor,
  updateAttributes,
  workspaceId,
}: PageLinkNodeViewProps) {
  const t = useTranslations('editor.pageLink');
  const title = pageLinkTitle(node.attrs);
  const documentId = pageLinkDocumentId(node.attrs);
  const router = useRouter();
  const followLinkRef = React.useContext(FollowLinkContext);
  const askPageLink = React.useContext(PageLinkPromptContext);
  const resolution = usePageLinkResolution(workspaceId, { documentId, title });

  const matches = resolution.data?.matches ?? [];
  const resolvedBy = resolution.data?.resolvedBy ?? 'none';
  const target: PageLinkResolution = resolvePageLinkTarget(
    { documentId, title },
    {
      // The endpoint tried the identity first and says whether it answered, so
      // the pure rule gets exactly the two lists it expects.
      byId: resolvedBy === 'id' ? (matches[0] ?? null) : null,
      byTitle: resolvedBy === 'title' ? matches : [],
    },
  );

  /**
   * The route this card points at, or `null` while it points at nothing
   * unambiguous — several pages carry the title, or none does.
   *
   * A known route is rendered as a real `href` below, which is what makes
   * middle click, Strg-/Cmd-click, "Link in neuem Tab öffnen" and copying the
   * address work at all (issue #29). `role="link"` without one is a promise to
   * a screen reader that nothing keeps.
   */
  const href =
    target.state === 'resolved' && !target.ambiguous
      ? `/arbeitsbereich/${workspaceId}/seite/${target.target.id}`
      : null;

  const activate = (): void => {
    // An unambiguous target is navigated to directly; everything else goes
    // through `follow`, which owns the "several pages" and "no such page"
    // dialogs including the offer to create one.
    if (href !== null) {
      router.push(href);
      return;
    }
    followLinkRef?.current?.(
      { kind: 'wiki', title, documentId },
      { download: false, newTab: false },
    );
  };

  const retarget = async (): Promise<void> => {
    const picked = await askPageLink?.current?.(title);
    if (picked === null || picked === undefined) return;
    updateAttributes({ documentId: picked.documentId, title: picked.title });
  };

  const unresolved = target.state === 'unresolved';

  // Built once and put inside whichever element the resolution calls for below.
  const label =
    target.state === 'resolved' ? (
      <PageLinkLabel
        match={matches[0] ?? null}
        title={target.target.title}
        ambiguous={target.ambiguous}
      />
    ) : null;

  return (
    <NodeViewWrapper
      contentEditable={false}
      className="exocortex-page-link"
      data-page-link=""
      data-testid={unresolved ? 'page-link-missing' : 'page-link-card'}
      data-resolved={unresolved ? 'missing' : undefined}
    >
      {resolution.isPending && (title.length > 0 || documentId !== null) ? (
        <LoadingState
          variant="skeleton"
          rows={1}
          label={title.length > 0 ? t('searching', { title }) : t('resolving')}
        />
      ) : target.state === 'unresolved' ? (
        <UnresolvedPageLink
          title={title}
          reason={target.reason}
          editable={editor.isEditable}
          onCreate={activate}
          onRetarget={() => void retarget()}
        />
      ) : (
        <ResolvedPageLink
          href={href}
          label={label}
          editable={editor.isEditable}
          onActivate={activate}
          onRetarget={() => void retarget()}
        />
      )}
    </NodeViewWrapper>
  );
}

/** A reference that points at no page: several carry the title, or none does. */
function UnresolvedPageLink({
  title,
  reason,
  editable,
  onCreate,
  onRetarget,
}: {
  title: string;
  reason: UnresolvedReason;
  editable: boolean;
  onCreate: () => void;
  onRetarget: () => void;
}) {
  const t = useTranslations('editor.pageLink');
  const reasonText = t(`unresolved.${reason}`);
  return (
    <div className="flex flex-1 items-center gap-2">
      <span className="truncate text-muted-foreground">
        {title.length > 0 ? t('unresolvedWithTitle', { title, reason: reasonText }) : reasonText}
      </span>
      {editable && reason !== 'empty' ? (
        <Button variant="outline" size="sm" data-testid="page-link-create" onClick={onCreate}>
          {t('createPage')}
        </Button>
      ) : null}
      {editable ? (
        <Button variant="ghost" size="sm" data-testid="page-link-retarget" onClick={onRetarget}>
          <PencilIcon aria-hidden /> {t('choosePage')}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A reference that found its page.
 *
 * An anchor when the target is known, a button when a click can only open the
 * "mehrere Seiten" dialog: the element type says which of the two the click
 * does, and the anchor is left to navigate on its own so a modifier still
 * reaches the browser.
 */
function ResolvedPageLink({
  href,
  label,
  editable,
  onActivate,
  onRetarget,
}: {
  href: string | null;
  label: React.ReactNode;
  editable: boolean;
  onActivate: () => void;
  onRetarget: () => void;
}) {
  const t = useTranslations('editor.pageLink');
  return (
    <div className="flex flex-1 items-center gap-2">
      {href === null ? (
        <button type="button" className={TARGET_CLASS} onClick={onActivate}>
          {label}
        </button>
      ) : (
        <Link href={href} className={TARGET_CLASS} data-testid="page-link-target">
          {label}
        </Link>
      )}
      {editable ? (
        <Button variant="ghost" size="sm" data-testid="page-link-retarget" onClick={onRetarget}>
          <PencilIcon aria-hidden /> {t('changePage')}
        </Button>
      ) : null}
    </div>
  );
}

/** Icon, title, and what else is worth saying about the page a reference found. */
function PageLinkLabel({
  match,
  title,
  ambiguous,
}: {
  match: DocumentLinkMatch | null;
  title: string;
  ambiguous: boolean;
}) {
  const t = useTranslations('editor.pageLink');
  return (
    <>
      <DocumentIcon
        icon={match?.icon ?? null}
        iconColor={match?.iconColor ?? null}
        type={match?.type ?? 'PAGE'}
      />
      <span className="truncate">{title}</span>
      {match?.archivedAt == null ? null : <Badge variant="muted">{t('inTrash')}</Badge>}
      {ambiguous ? <span className="text-xs text-muted-foreground">{t('ambiguous')}</span> : null}
    </>
  );
}
