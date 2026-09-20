'use client';

import { type NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper } from '@tiptap/react';
import { ExternalLinkIcon, RefreshCwIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Button, EmptyState, LoadingState } from '@exocortex/ui';

import { DatabaseEmbedPromptContext } from '@/components/editor/database-embed-context';
import { useDocument } from '@/lib/api/document-queries';

import { DatabaseShell } from './database-shell';

interface DatabaseEmbedNodeViewProps extends NodeViewProps {
  workspaceId: string;
}

/**
 * React node view for the `databaseEmbed` node (`packages/editor/src/database-embed.ts`).
 *
 * Wraps the same `DatabaseShell` the full-page database view uses, so filters,
 * sorting, inline cell edits and adding a row work identically here. See
 * `docs/editor-extensions.md` for why this is the one node whose rendering
 * lives entirely in `apps/web` instead of as plain DOM in `packages/editor`.
 */
export function DatabaseEmbedNodeView({
  node,
  updateAttributes,
  editor,
  workspaceId,
}: DatabaseEmbedNodeViewProps) {
  const documentId = typeof node.attrs.documentId === 'string' ? node.attrs.documentId : '';
  const viewId = typeof node.attrs.viewId === 'string' ? node.attrs.viewId : undefined;
  const frozenTitle = typeof node.attrs.title === 'string' ? node.attrs.title : '';

  const doc = useDocument(documentId.length > 0 ? documentId : undefined);
  const askDatabase = React.useContext(DatabaseEmbedPromptContext);
  const editable = editor.isEditable;

  const pickDatabase = async (): Promise<void> => {
    const picked = await askDatabase?.current?.();
    if (picked === null || picked === undefined) return;
    updateAttributes({ documentId: picked.documentId, title: picked.title, viewId: null });
  };

  const title = doc.data?.title ?? (frozenTitle.length > 0 ? frozenTitle : 'Datenbank');
  const missing = documentId.length === 0 || doc.isError;

  return (
    <NodeViewWrapper className="exocortex-database-embed" contentEditable={false}>
      <div className="embed-header">
        <span className="embed-title">{title}</span>
        <div className="embed-actions">
          {missing ? null : (
            <Link
              href={`/arbeitsbereich/${workspaceId}/seite/${documentId}`}
              className="embed-action"
            >
              <ExternalLinkIcon aria-hidden />
              In eigener Seite öffnen
            </Link>
          )}
          {editable ? (
            <Button
              variant="ghost"
              size="sm"
              className="embed-action"
              onClick={() => void pickDatabase()}
            >
              <RefreshCwIcon aria-hidden />
              Datenbank wechseln
            </Button>
          ) : null}
        </div>
      </div>

      {missing ? (
        <EmptyState
          title="Keine Datenbank ausgewählt"
          description={
            documentId.length === 0
              ? 'Wähle eine Datenbank, die hier eingebettet werden soll.'
              : 'Diese Datenbank wurde nicht gefunden. Sie wurde möglicherweise gelöscht.'
          }
          action={
            editable
              ? { label: 'Datenbank auswählen', onClick: () => void pickDatabase() }
              : undefined
          }
        />
      ) : doc.isPending ? (
        <LoadingState variant="skeleton" rows={3} label="Datenbank wird geladen" />
      ) : (
        <DatabaseShell
          workspaceId={workspaceId}
          documentId={documentId}
          readOnly={!editable}
          activeViewId={viewId}
          onActiveViewChange={(nextViewId) => updateAttributes({ viewId: nextViewId })}
        />
      )}
    </NodeViewWrapper>
  );
}
