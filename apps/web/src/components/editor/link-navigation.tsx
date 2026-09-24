'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { type DocumentLinkMatch } from '@exocortex/contracts';
import { type LinkTarget } from '@exocortex/editor';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { ApiError } from '@/lib/api/client';
import { useCreateDocument } from '@/lib/api/document-queries';
import { pageLinkQueryOptions } from '@/lib/api/page-link-queries';
import { queryKeys } from '@/lib/api/query-keys';
import { useWorkspaces } from '@/lib/api/workspace-queries';

import { type FollowLink, type FollowLinkOptions } from './follow-link-context';

type PendingDialog =
  | { mode: 'ambiguous'; title: string; matches: readonly DocumentLinkMatch[] }
  | { mode: 'missing'; title: string }
  | { mode: 'error'; message: string };

export interface UseLinkNavigationOptions {
  workspaceId: string;
}

export interface LinkNavigationController {
  follow: FollowLink;
  /** The three dialogs this can show; render it once next to the editor. */
  element: React.ReactNode;
}

/**
 * Everything a click on a resolved link target does outside the editor's own
 * state: opening a new tab, pushing a route, or — for a `wiki:` title —
 * looking it up and showing whichever of three dialogs the result calls for.
 *
 * Named and shaped like `useBlockPrompt`: an `ask`-style entry point plus an
 * `element` to render once. The click path itself never touches the Yjs
 * document (no `chain()`, no `focus()`, ADR-016 does not apply here), so
 * following a link is never a collaborative edit.
 */
export function useLinkNavigation({
  workspaceId,
}: UseLinkNavigationOptions): LinkNavigationController {
  const router = useRouter();
  const queryClient = useQueryClient();
  const workspaces = useWorkspaces();
  const createDocument = useCreateDocument(workspaceId);
  const [pending, setPending] = React.useState<PendingDialog | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

  // `editable` alone is not enough: an archived page is read-only, but the
  // member who opened it may still create a page from a dead link on it.
  const role = workspaces.data?.find((workspace) => workspace.id === workspaceId)?.role;
  const canCreate = role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER';

  /** `router.push` or a second tab, whichever the click asked for. */
  const goTo = React.useCallback(
    (path: string, newTab: boolean): void => {
      if (newTab) window.open(path, '_blank', 'noopener');
      else router.push(path);
    },
    [router],
  );

  const followWiki = React.useCallback(
    async (
      reference: { title: string; documentId?: string | null },
      newTab: boolean,
    ): Promise<void> => {
      let response;
      try {
        response = await queryClient.fetchQuery(pageLinkQueryOptions(workspaceId, reference));
      } catch (error) {
        setPending({
          mode: 'error',
          message:
            error instanceof ApiError
              ? error.message
              : 'Der Verweis konnte nicht aufgelöst werden.',
        });
        return;
      }
      if (response.matches.length === 1) {
        goTo(`/arbeitsbereich/${workspaceId}/seite/${response.matches[0]?.id}`, newTab);
        return;
      }
      if (response.matches.length === 0) {
        setPending({ mode: 'missing', title: response.title });
        return;
      }
      setPending({ mode: 'ambiguous', title: response.title, matches: response.matches });
    },
    [goTo, queryClient, workspaceId],
  );

  const follow = React.useCallback<FollowLink>(
    (target: LinkTarget, options: FollowLinkOptions) => {
      switch (target.kind) {
        case 'external':
          // `newTab` is what the anchor and the click together asked for, not a
          // house rule: every external link the schema renders carries
          // `target="_blank"`, so the usual case is unchanged, but a link that
          // does not — and a plain click on one — now stays in this tab
          // (issue #29).
          if (options.newTab) window.open(target.url, '_blank', 'noopener,noreferrer');
          else window.location.assign(target.url);
          return;
        case 'mailto':
          // A second tab for a `mailto:` would be an empty tab: the handler
          // takes over either way.
          window.location.href = target.url;
          return;
        case 'attachment':
          // A `contenteditable` root does not let the browser follow anchors
          // on its own, so both the download and the open-in-new-tab case are
          // done by hand here. A binary always gets its own tab: replacing the
          // workspace with a PDF viewer is never what a click meant.
          if (options.download) {
            const anchor = document.createElement('a');
            anchor.href = target.path;
            anchor.download = '';
            anchor.click();
          } else {
            window.open(target.path, '_blank', 'noopener');
          }
          return;
        case 'route':
          goTo(target.path, options.newTab);
          return;
        case 'anchor':
          document
            .querySelector(`[data-block-id="${target.blockId}"]`)
            ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          return;
        case 'wiki':
          void followWiki(
            { title: target.title, documentId: target.documentId ?? null },
            options.newTab,
          );
          return;
        case 'unknown':
          return;
      }
    },
    [followWiki, goTo],
  );

  const closeDialog = (): void => {
    setPending(null);
    setCreateError(null);
  };

  const createPage = async (title: string): Promise<void> => {
    setCreateError(null);
    setCreating(true);
    try {
      const created = await createDocument.mutateAsync({ title, type: 'PAGE', parentId: null });
      // The title is unchanged, so the same link resolves to the new page next
      // time. Invalidating by title alone would miss a `pageLink` whose cache
      // entry also carries an identity, so the whole namespace goes.
      void queryClient.invalidateQueries({ queryKey: queryKeys.pageLinks(workspaceId) });
      setPending(null);
      router.push(`/arbeitsbereich/${workspaceId}/seite/${created.id}`);
    } catch (error) {
      setCreateError(
        error instanceof ApiError ? error.message : 'Die Seite konnte nicht angelegt werden.',
      );
    } finally {
      setCreating(false);
    }
  };

  const element = (
    <>
      <Dialog open={pending?.mode === 'ambiguous'} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent data-testid="link-ambiguous-dialog">
          <DialogHeader>
            <DialogTitle>
              Mehrere Seiten heißen „{pending?.mode === 'ambiguous' ? pending.title : ''}“
            </DialogTitle>
            <DialogDescription>Wähle die gemeinte Seite aus.</DialogDescription>
          </DialogHeader>
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {pending?.mode === 'ambiguous'
              ? pending.matches.map((match) => (
                  <li key={match.id}>
                    <button
                      type="button"
                      data-testid={`link-ambiguous-option-${match.id}`}
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
                      onClick={() => {
                        closeDialog();
                        router.push(`/arbeitsbereich/${workspaceId}/seite/${match.id}`);
                      }}
                    >
                      <DocumentIcon
                        icon={match.icon}
                        iconColor={match.iconColor}
                        type={match.type}
                      />
                      <span className="flex-1 truncate">{match.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {match.path.map((ancestor) => ancestor.title).join(' / ')}
                      </span>
                      {match.archivedAt === null ? null : (
                        <Badge variant="muted">Im Papierkorb</Badge>
                      )}
                    </button>
                  </li>
                ))
              : null}
          </ul>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              Abbrechen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pending?.mode === 'missing'} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent data-testid="link-missing-dialog">
          <DialogHeader>
            <DialogTitle>Seite nicht gefunden</DialogTitle>
            <DialogDescription>
              Es gibt keine Seite mit dem Titel „{pending?.mode === 'missing' ? pending.title : ''}“
              in diesem Arbeitsbereich.
            </DialogDescription>
          </DialogHeader>
          {createError === null ? null : (
            <p className="text-xs text-destructive-text" role="alert">
              {createError}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              Abbrechen
            </Button>
            {canCreate && pending?.mode === 'missing' ? (
              <Button
                data-testid="link-create-page"
                disabled={creating}
                onClick={() => void createPage(pending.title)}
              >
                Seite anlegen
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pending?.mode === 'error'} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent data-testid="link-error-dialog">
          <DialogHeader>
            <DialogTitle>Verweis konnte nicht geöffnet werden</DialogTitle>
            <DialogDescription>
              {pending?.mode === 'error' ? pending.message : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              Schließen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  return { follow, element };
}
