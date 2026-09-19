'use client';

import { useQueryClient } from '@tanstack/react-query';
import { FolderTreeIcon } from 'lucide-react';
import * as React from 'react';

import {
  type DocumentShare,
  type DocumentTreeNode,
  type ParentSuggestion,
  type ShareListResponse,
} from '@exocortex/contracts';
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

import { ApiError, apiRequest } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useSuggestParent } from '@/lib/api/placement-queries';
import { useMoveDocument } from '@/lib/api/queries';
import { shareKeys } from '@/lib/api/share-queries';

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
  /**
   * The page to file. Narrower than a tree node on purpose: the same dialog
   * serves the tree's context menu and the open page in the inbox (issue #71),
   * and neither the suggestions nor the move need anything below the page.
   */
  node: Pick<DocumentTreeNode, 'id' | 'title' | 'parentId'> | null;
  onClose: () => void;
}) {
  const suggestions = useSuggestParent(workspaceId, node?.id, node !== null);
  const moveDocument = useMoveDocument(workspaceId);

  /*
   * Moving a page into a shared branch shares it, and nothing about the act
   * looks like sharing (issue #83, ADR-044). So a target is asked about before
   * the page lands in it: a target that inherits nothing moves straight away,
   * and one that does stops here and says what it would hand over.
   *
   * The question is asked imperatively rather than as a standing query, because
   * the answer decides what happens next. A `useQuery` would arrive in a render
   * and need an effect to act on it, which is the shape React asks us not to
   * write -- and here it would also mean a click whose consequence lands a tick
   * later.
   */
  const queryClient = useQueryClient();
  const [warning, setWarning] = React.useState<{
    target: { parentId: string; title: string };
    shares: DocumentShare[];
  } | null>(null);
  const [checking, setChecking] = React.useState(false);

  const move = (parentId: string | null): void => {
    if (node === null) return;
    void moveDocument
      .mutateAsync({ documentId: node.id, request: { parentId } })
      .then(() => onClose());
  };

  const proposeMove = async (suggestion: ParentSuggestion): Promise<void> => {
    setWarning(null);
    // The workspace root inherits nothing by definition, so it never waits.
    if (suggestion.parentId === null) {
      move(null);
      return;
    }
    setChecking(true);
    try {
      const inherited = await queryClient.fetchQuery({
        queryKey: shareKeys.inherited(suggestion.parentId),
        queryFn: () =>
          apiRequest<ShareListResponse>(
            `/api/documents/${suggestion.parentId ?? ''}/inherited-shares`,
          ),
        staleTime: 0,
      });
      if (inherited.inherited.length === 0) {
        move(suggestion.parentId);
        return;
      }
      setWarning({
        target: { parentId: suggestion.parentId, title: suggestion.title },
        shares: inherited.inherited,
      });
    } finally {
      setChecking(false);
    }
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

        {warning !== null ? (
          <Alert data-testid="suggest-parent-share-warning">
            <AlertDescription>
              „{warning.target.title}“ ist nach außen freigegeben, mitsamt allem darunter. Wenn „
              {node?.title}“ dort landet, ist sie damit auch freigegeben:
              <ul className="mt-2 list-disc pl-4">
                {warning.shares.map((share) => (
                  <li key={share.id}>
                    {share.kind === 'PUBLIC_LINK'
                      ? 'Öffentlicher Link (jeder mit der Adresse liest mit)'
                      : `Freigegeben an ${share.grantee?.email ?? 'ein Konto'}`}
                  </li>
                ))}
              </ul>
              <span className="mt-2 flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setWarning(null)}>
                  Abbrechen
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="suggest-parent-share-confirm"
                  onClick={() => {
                    const target = warning.target.parentId;
                    setWarning(null);
                    move(target);
                  }}
                >
                  Trotzdem verschieben
                </Button>
              </span>
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
                disabled={
                  moveDocument.isPending || checking || suggestion.parentId === node?.parentId
                }
                current={suggestion.parentId === node?.parentId}
                onMove={() => void proposeMove(suggestion)}
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
