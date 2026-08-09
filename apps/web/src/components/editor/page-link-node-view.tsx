'use client';

import { type NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper } from '@tiptap/react';
import { PencilIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  pageLinkDocumentId,
  type PageLinkResolution,
  pageLinkTitle,
  resolvePageLinkTarget,
} from '@exocortex/editor';
import { Badge, Button, LoadingState } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { usePageLinkResolution } from '@/lib/api/queries';

import { FollowLinkContext } from './follow-link-context';
import { PageLinkPromptContext } from './page-link-context';

interface PageLinkNodeViewProps extends NodeViewProps {
  workspaceId: string;
}

/** German for each way a reference can fail to name a page. */
const UNRESOLVED_TEXT: Readonly<Record<'empty' | 'deleted' | 'missing', string>> = {
  empty: 'Kein Ziel gewählt',
  deleted: 'Zielseite gelöscht',
  missing: 'Seite existiert nicht',
};

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

  const activate = (): void => {
    // An unambiguous target is navigated to directly; everything else goes
    // through `follow`, which owns the "several pages" and "no such page"
    // dialogs including the offer to create one.
    if (target.state === 'resolved' && !target.ambiguous) {
      router.push(`/arbeitsbereich/${workspaceId}/seite/${target.target.id}`);
      return;
    }
    followLinkRef?.current?.({ kind: 'wiki', title }, { download: false });
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  };

  const retarget = async (): Promise<void> => {
    const picked = await askPageLink?.current?.(title);
    if (picked === null || picked === undefined) return;
    updateAttributes({ documentId: picked.documentId, title: picked.title });
  };

  const unresolved = target.state === 'unresolved';

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
          label={title.length > 0 ? `„${title}“ wird gesucht` : 'Verweis wird aufgelöst'}
        />
      ) : target.state === 'unresolved' ? (
        <div className="flex flex-1 items-center gap-2">
          <span className="truncate text-muted-foreground">
            {title.length > 0 ? `${title} — ` : ''}
            {UNRESOLVED_TEXT[target.reason]}
          </span>
          {editor.isEditable && target.reason !== 'empty' ? (
            <Button variant="outline" size="sm" data-testid="page-link-create" onClick={activate}>
              Seite anlegen
            </Button>
          ) : null}
          {editor.isEditable ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="page-link-retarget"
              onClick={() => void retarget()}
            >
              <PencilIcon aria-hidden /> Seite wählen
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-1 items-center gap-2">
          <div
            role="link"
            tabIndex={0}
            className="flex min-w-0 flex-1 items-center gap-2"
            onClick={activate}
            onKeyDown={onKeyDown}
          >
            <DocumentIcon
              icon={matches[0]?.icon ?? null}
              iconColor={matches[0]?.iconColor ?? null}
              type={matches[0]?.type ?? 'PAGE'}
            />
            <span className="truncate">{target.target.title}</span>
            {matches[0]?.archivedAt == null ? null : <Badge variant="muted">Archiviert</Badge>}
            {target.ambiguous ? (
              <span className="text-xs text-muted-foreground">Mehrere Seiten mit diesem Titel</span>
            ) : null}
          </div>
          {editor.isEditable ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="page-link-retarget"
              onClick={() => void retarget()}
            >
              <PencilIcon aria-hidden /> Seite ändern
            </Button>
          ) : null}
        </div>
      )}
    </NodeViewWrapper>
  );
}
