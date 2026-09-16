'use client';

import { FolderTreeIcon } from 'lucide-react';
import * as React from 'react';

import { type DocumentTreeNode, type ParentSuggestion } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  LoadingState,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useSuggestParent } from '@/lib/api/placement-queries';
import { useMoveDocument } from '@/lib/api/queries';

/**
 * "Wohin gehört diese Seite?" for the person, not just for the agent.
 *
 * The same answer the MCP catalogue gets from `exo_page_suggest_parent`
 * (ADR-025: the browser, the built-in AI and MCP reach the same capabilities),
 * and the same reason travels with it: a suggestion is only worth acting on if
 * you can see the pages it was derived from. So each candidate names the
 * neighbours that already live there, and moving is a separate click on the
 * candidate you agreed with.
 */
export function SuggestParentDialog({
  workspaceId,
  node,
  onClose,
}: {
  workspaceId: string;
  node: DocumentTreeNode | null;
  onClose: () => void;
}) {
  const suggestions = useSuggestParent(workspaceId, node?.id, node !== null);
  const moveDocument = useMoveDocument(workspaceId);

  const move = (suggestion: ParentSuggestion): void => {
    if (node === null) return;
    void moveDocument
      .mutateAsync({ documentId: node.id, request: { parentId: suggestion.parentId } })
      .then(() => onClose());
  };

  return (
    <Dialog
      open={node !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Passenden Ort vorschlagen</DialogTitle>
          <DialogDescription>
            Für „{node?.title}“ gesucht: die Seiten, die inhaltlich am nächsten liegen.
            Vorgeschlagen wird, wo die meisten davon bereits hängen.
          </DialogDescription>
        </DialogHeader>

        {moveDocument.isError ? (
          <Alert variant="destructive" data-testid="suggest-parent-error">
            <AlertDescription>
              {messageForCode(
                moveDocument.error instanceof ApiError ? moveDocument.error.code : undefined,
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        {suggestions.isPending ? (
          <LoadingState variant="skeleton" rows={3} label="Vorschläge werden gesucht" />
        ) : suggestions.isError ? (
          <ErrorState onRetry={() => void suggestions.refetch()} title="Vorschläge nicht geladen" />
        ) : suggestions.data.suggestions.length === 0 ? (
          <EmptyState
            title="Kein Vorschlag"
            description="Es gibt keine Seiten, die dieser hier inhaltlich nahe genug sind. Verschieb sie im Seitenbaum von Hand."
          />
        ) : (
          <ul className="flex flex-col gap-1" data-testid="suggest-parent-list">
            {suggestions.data.suggestions.map((suggestion) => (
              <SuggestionRow
                key={suggestion.parentId ?? 'root'}
                suggestion={suggestion}
                disabled={moveDocument.isPending || suggestion.parentId === node?.parentId}
                current={suggestion.parentId === node?.parentId}
                onMove={() => move(suggestion)}
              />
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Schließen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One candidate: where it sits, what already lives there, and the way to act on it. */
function SuggestionRow({
  suggestion,
  disabled,
  current,
  onMove,
}: {
  suggestion: ParentSuggestion;
  disabled: boolean;
  current: boolean;
  onMove: () => void;
}) {
  const location =
    suggestion.path.length === 0
      ? 'oberste Ebene'
      : suggestion.path.map((entry) => entry.title).join(' › ');

  return (
    <li className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-accent/60">
      <FolderTreeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{suggestion.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {location} · {suggestion.childCount} Unterseiten
        </span>
        {suggestion.matches.length > 0 ? (
          <span className="line-clamp-2 text-xs text-muted-foreground">
            Dort liegen bereits: {suggestion.matches.map((match) => match.title).join(', ')}
          </span>
        ) : null}
      </div>
      <Button
        size="sm"
        variant={current ? 'ghost' : 'outline'}
        disabled={disabled}
        onClick={onMove}
        data-testid={`suggest-parent-move-${suggestion.parentId ?? 'root'}`}
      >
        {current ? 'Liegt hier' : 'Hierhin'}
      </Button>
    </li>
  );
}
