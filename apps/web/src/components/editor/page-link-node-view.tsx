'use client';

import { type NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper } from '@tiptap/react';
import * as React from 'react';

import { Badge, Button, LoadingState } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { usePageLinkResolution } from '@/lib/api/queries';

import { FollowLinkContext } from './follow-link-context';

interface PageLinkNodeViewProps extends NodeViewProps {
  workspaceId: string;
}

/**
 * React node view for the `pageLink` node (`packages/editor/src/page-link.ts`).
 *
 * Shows what a plain anchor never could: the target's icon, its path when
 * there is more than one page with that title, or that no page has this
 * title at all. Resolution to a document is application knowledge, not
 * schema knowledge, which is why this lives here and not in `packages/editor`
 * (see `docs/editor-extensions.md`).
 *
 * Deliberately **no** `stopPropagation` as a guard against the editor-wide
 * click handler in `collaborative-editor.tsx`: ProseMirror listens on
 * `view.dom`, React listens on its own root above that, so React's
 * `stopPropagation` runs too late to matter. The actual guard is the
 * `[data-page-link]` check in that handler's `followFromEvent`.
 */
export function PageLinkNodeView({ node, editor, workspaceId }: PageLinkNodeViewProps) {
  const title = typeof node.attrs.title === 'string' ? node.attrs.title : '';
  const followLinkRef = React.useContext(FollowLinkContext);
  const resolution = usePageLinkResolution(workspaceId, title);

  const activate = (): void => {
    followLinkRef?.current?.({ kind: 'wiki', title }, { download: false });
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  };

  const matches = resolution.data?.matches ?? [];
  const first = matches[0];
  const missing = !resolution.isPending && first === undefined;

  return (
    <NodeViewWrapper
      contentEditable={false}
      className="exocortex-page-link"
      data-page-link=""
      data-testid={missing ? 'page-link-missing' : 'page-link-card'}
      data-resolved={missing ? 'missing' : undefined}
    >
      {title.length === 0 ? (
        <span className="text-muted-foreground italic">Kein Titel</span>
      ) : resolution.isPending ? (
        <LoadingState variant="skeleton" rows={1} label={`„${title}“ wird gesucht`} />
      ) : first === undefined ? (
        <div className="flex flex-1 items-center gap-2">
          <span className="truncate text-muted-foreground">{title} — Seite existiert nicht</span>
          {editor.isEditable ? (
            <Button variant="outline" size="sm" data-testid="page-link-create" onClick={activate}>
              Seite anlegen
            </Button>
          ) : null}
        </div>
      ) : (
        <div
          role="link"
          tabIndex={0}
          className="flex flex-1 items-center gap-2"
          onClick={activate}
          onKeyDown={onKeyDown}
        >
          <DocumentIcon icon={first.icon} iconColor={first.iconColor} type={first.type} />
          <span className="truncate">{first.title}</span>
          {first.archivedAt === null ? null : <Badge variant="muted">Archiviert</Badge>}
          {matches.length > 1 ? (
            <span className="text-xs text-muted-foreground">Mehrere Seiten mit diesem Titel</span>
          ) : null}
        </div>
      )}
    </NodeViewWrapper>
  );
}
