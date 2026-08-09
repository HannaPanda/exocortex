'use client';

import {
  CheckIcon,
  ChevronDownIcon,
  CornerDownRightIcon,
  Link2OffIcon,
  MessageSquareIcon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react';
import * as React from 'react';

import { type Comment, type CommentThread } from '@exocortex/contracts';
import {
  Badge,
  Button,
  cn,
  EmptyState,
  ErrorState,
  LoadingState,
  Textarea,
} from '@exocortex/ui';

import { useCommentAnchor } from '@/components/comments/comment-anchor';
import { initialsOf } from '@/components/shell/document-session';
import {
  useCommentRealtimeSync,
  useComments,
  useCreateComment,
  useDeleteComment,
  useResolveComment,
  useUpdateComment,
} from '@/lib/api/comment-queries';
import { useDocument, useSessionQuery, useWorkspaces } from '@/lib/api/queries';

export interface CommentsPanelProps {
  workspaceId: string | null;
  documentId: string | null;
}

function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Author initials plus name and time. The same line above every remark. */
function CommentByline({ comment }: { comment: Comment }) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[0.625rem] font-medium text-muted-foreground"
      >
        {initialsOf(comment.createdBy.name)}
      </span>
      <span className="truncate text-xs font-medium">{comment.createdBy.name}</span>
      <span className="exocortex-numeric shrink-0 text-[0.6875rem] text-muted-foreground">
        {formatMoment(comment.createdAt)}
      </span>
      {comment.editedAt === null ? null : (
        <span className="shrink-0 text-[0.6875rem] text-muted-foreground">bearbeitet</span>
      )}
    </div>
  );
}

/** A single remark: its byline, its text, and what the reader may do with it. */
function CommentBody({
  comment,
  canEdit,
  canDelete,
  onEdit,
  onDelete,
  busy,
}: {
  comment: Comment;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (body: string) => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(comment.body);

  if (editing) {
    return (
      <div className="flex flex-col gap-1.5">
        <CommentByline comment={comment} />
        <Textarea
          rows={3}
          value={draft}
          aria-label="Kommentar bearbeiten"
          data-testid="comment-edit-input"
          className="text-xs"
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(comment.body);
              setEditing(false);
            }}
          >
            Abbrechen
          </Button>
          <Button
            size="sm"
            disabled={busy || draft.trim().length === 0 || draft.trim() === comment.body}
            data-testid="comment-edit-save"
            onClick={() => {
              onEdit(draft.trim());
              setEditing(false);
            }}
          >
            Speichern
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <CommentByline comment={comment} />
      <p className="text-xs whitespace-pre-wrap">{comment.body}</p>
      {canEdit || canDelete ? (
        <div className="flex gap-1">
          {canEdit ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Kommentar bearbeiten"
              data-testid="comment-edit"
              onClick={() => setEditing(true)}
            >
              <PencilIcon /> Bearbeiten
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Kommentar löschen"
              data-testid="comment-delete"
              disabled={busy}
              onClick={onDelete}
            >
              <Trash2Icon /> Löschen
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Where a thread hangs: the whole page, a quoted passage, or a passage that is gone. */
function AnchorLine({ thread, onReveal }: { thread: CommentThread; onReveal: () => void }) {
  const { blockId, anchorText, orphaned } = thread.root;

  if (blockId === null) {
    return <span className="text-[0.6875rem] text-muted-foreground">Zur ganzen Seite</span>;
  }

  if (orphaned) {
    return (
      <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
        <Link2OffIcon className="size-3 shrink-0" aria-hidden />
        <Badge variant="muted">Verwaist</Badge>
        {anchorText === null ? 'Die kommentierte Stelle wurde gelöscht.' : `„${anchorText}"`}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="truncate text-left text-[0.6875rem] text-muted-foreground underline decoration-dotted hover:text-foreground"
      data-testid="comment-reveal-anchor"
      onClick={onReveal}
    >
      {anchorText === null ? 'Zur kommentierten Stelle' : `„${anchorText}"`}
    </button>
  );
}

interface ThreadCardProps {
  thread: CommentThread;
  documentId: string;
  currentUserId: string | null;
  canWrite: boolean;
  /** ADMIN and OWNER may delete a remark that is not theirs. */
  canModerate: boolean;
  highlighted: boolean;
}

function ThreadCard({
  thread,
  documentId,
  currentUserId,
  canWrite,
  canModerate,
  highlighted,
}: ThreadCardProps) {
  const { revealBlock } = useCommentAnchor();
  const createComment = useCreateComment(documentId);
  const updateComment = useUpdateComment(documentId);
  const resolveComment = useResolveComment(documentId);
  const deleteComment = useDeleteComment(documentId);

  const [replyOpen, setReplyOpen] = React.useState(false);
  const [replyDraft, setReplyDraft] = React.useState('');
  const cardRef = React.useRef<HTMLElement>(null);

  const resolved = thread.root.resolvedAt !== null;
  // A resolved thread collapses to its first line instead of being deleted: the
  // discussion is the record of why the page reads the way it does. Being
  // pointed at from the text overrides the collapse without touching it, so
  // the thread folds back up again once the reader moves on.
  const [collapsed, setCollapsed] = React.useState(resolved);
  const expanded = !collapsed || highlighted;

  // Scrolling is an external system, which is what an effect is for; the
  // expansion above is derived instead, so no render cascades from it.
  React.useEffect(() => {
    if (!highlighted) return;
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlighted]);

  const busy =
    createComment.isPending ||
    updateComment.isPending ||
    resolveComment.isPending ||
    deleteComment.isPending;

  const mayTouch = (comment: Comment): { edit: boolean; remove: boolean } => ({
    edit: canWrite && comment.createdBy.id === currentUserId,
    remove: canWrite && (comment.createdBy.id === currentUserId || canModerate),
  });

  return (
    <section
      ref={cardRef}
      data-testid="comment-thread"
      data-resolved={resolved ? '' : undefined}
      className={cn(
        'flex flex-col gap-2 rounded-md border px-2 py-2',
        resolved ? 'border-border bg-muted/40' : 'border-border',
        highlighted ? 'ring-2 ring-ring' : undefined,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <AnchorLine
          thread={thread}
          onReveal={() => {
            if (thread.root.blockId !== null) revealBlock(thread.root.blockId);
          }}
        />
        {resolved ? (
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 text-[0.6875rem] text-muted-foreground"
            aria-expanded={expanded}
            data-testid="comment-thread-toggle"
            onClick={() => setCollapsed((closed) => !closed)}
          >
            <ChevronDownIcon
              className={cn('size-3 transition-transform', expanded ? 'rotate-180' : undefined)}
            />
            Erledigt
          </button>
        ) : null}
      </div>

      {expanded ? (
        <>
          <CommentBody
            comment={thread.root}
            canEdit={mayTouch(thread.root).edit}
            canDelete={mayTouch(thread.root).remove}
            busy={busy}
            onEdit={(body) => {
              void updateComment.mutateAsync({ commentId: thread.root.id, body });
            }}
            onDelete={() => void deleteComment.mutateAsync(thread.root.id)}
          />

          {thread.replies.length === 0 ? null : (
            <div className="flex flex-col gap-2 border-l border-border pl-2">
              {thread.replies.map((reply) => (
                <CommentBody
                  key={reply.id}
                  comment={reply}
                  canEdit={mayTouch(reply).edit}
                  canDelete={mayTouch(reply).remove}
                  busy={busy}
                  onEdit={(body) => {
                    void updateComment.mutateAsync({ commentId: reply.id, body });
                  }}
                  onDelete={() => void deleteComment.mutateAsync(reply.id)}
                />
              ))}
            </div>
          )}

          {canWrite ? (
            <div className="flex flex-col gap-1.5">
              {replyOpen ? (
                <>
                  <Textarea
                    rows={2}
                    autoFocus
                    value={replyDraft}
                    placeholder="Antworten …"
                    aria-label="Antwort schreiben"
                    data-testid="comment-reply-input"
                    className="text-xs"
                    onChange={(event) => setReplyDraft(event.target.value)}
                  />
                  <div className="flex gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => setReplyOpen(false)}>
                      Abbrechen
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || replyDraft.trim().length === 0}
                      data-testid="comment-reply-submit"
                      onClick={() => {
                        void createComment
                          .mutateAsync({ body: replyDraft.trim(), parentId: thread.root.id })
                          .then(() => {
                            setReplyDraft('');
                            setReplyOpen(false);
                          });
                      }}
                    >
                      Antworten
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="comment-reply"
                    onClick={() => setReplyOpen(true)}
                  >
                    <CornerDownRightIcon /> Antworten
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    data-testid="comment-resolve"
                    onClick={() => {
                      void resolveComment.mutateAsync({
                        commentId: thread.root.id,
                        resolved: !resolved,
                      });
                    }}
                  >
                    {resolved ? (
                      <>
                        <RotateCcwIcon /> Wieder öffnen
                      </>
                    ) : (
                      <>
                        <CheckIcon /> Erledigt
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>
          ) : null}
        </>
      ) : (
        <p className="line-clamp-1 text-xs text-muted-foreground">{thread.root.body}</p>
      )}
    </section>
  );
}

/** The composer for a new thread: page-wide, or anchored to the marked passage. */
function NewThreadComposer({
  documentId,
  anchor,
  onDone,
}: {
  documentId: string;
  anchor: { blockId: string | null; quote: string };
  onDone: () => void;
}) {
  const createComment = useCreateComment(documentId);
  const [draft, setDraft] = React.useState('');
  const quote = anchor.quote.trim();

  const submit = (): void => {
    const body = draft.trim();
    if (body.length === 0) return;
    void createComment
      .mutateAsync({
        body,
        blockId: anchor.blockId,
        // The quote is only worth storing for an anchored thread; a page-wide
        // remark has nothing that could go missing.
        anchorText: anchor.blockId === null || quote.length === 0 ? null : quote,
      })
      .then(() => {
        setDraft('');
        onDone();
      });
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card px-2 py-2">
      {anchor.blockId === null ? (
        <span className="text-[0.6875rem] text-muted-foreground">Kommentar zur ganzen Seite</span>
      ) : (
        <span className="truncate text-[0.6875rem] text-muted-foreground">
          {quote.length === 0 ? 'Kommentar zur markierten Stelle' : `Zur Stelle: „${quote}"`}
        </span>
      )}
      <Textarea
        rows={3}
        value={draft}
        placeholder="Anmerkung schreiben … Mit @ lassen sich Personen und Seiten erwähnen."
        aria-label="Neuen Kommentar schreiben"
        data-testid="comment-new-input"
        className="text-xs"
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="flex gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft('');
            onDone();
          }}
        >
          Abbrechen
        </Button>
        <Button
          size="sm"
          disabled={createComment.isPending || draft.trim().length === 0}
          data-testid="comment-new-submit"
          onClick={submit}
        >
          Kommentieren
        </Button>
      </div>
    </div>
  );
}

/**
 * The "Kommentare" tab: every thread of the open page (issue #18).
 *
 * Open threads first, resolved ones collapsed underneath — never deleted, since
 * a resolved discussion is the record of why a page reads the way it does. A
 * thread whose anchored block has been deleted stays too and says it is
 * orphaned, with the quote taken when it was written.
 */
export function CommentsPanel({ workspaceId, documentId }: CommentsPanelProps) {
  const session = useSessionQuery();
  const workspaces = useWorkspaces();
  const document = useDocument(documentId ?? undefined);
  const comments = useComments(documentId ?? undefined);
  const { request, clearRequest } = useCommentAnchor();

  useCommentRealtimeSync(documentId);

  // "Neu" in this panel's own header. The editor's requests are read below
  // rather than copied into state: mirroring them would need an effect, and an
  // effect that calls `setState` is a render cascade for something that is
  // already a plain function of the props.
  const [composingPageWide, setComposingPageWide] = React.useState(false);

  const editorRequest = request !== null && request.documentId === documentId ? request : null;
  const composing =
    editorRequest?.kind === 'compose'
      ? { blockId: editorRequest.blockId, quote: editorRequest.quote }
      : composingPageWide
        ? { blockId: null, quote: '' }
        : null;
  const highlightedBlockId = editorRequest?.kind === 'focus' ? editorRequest.blockId : null;

  const closeComposer = (): void => {
    setComposingPageWide(false);
    clearRequest();
  };

  if (documentId === null || workspaceId === null) {
    return (
      <EmptyState
        title="Keine Seite geöffnet"
        description="Öffne eine Seite, um ihre Kommentare zu sehen."
        icon={MessageSquareIcon}
      />
    );
  }

  if (comments.isPending || document.isPending) {
    return <LoadingState variant="skeleton" rows={4} label="Kommentare werden geladen …" />;
  }
  if (comments.isError) {
    return (
      <ErrorState
        title="Kommentare nicht verfügbar"
        description="Die Kommentare dieser Seite konnten nicht geladen werden."
        onRetry={() => void comments.refetch()}
      />
    );
  }

  const detail = document.isSuccess ? document.data : null;
  // The same bar the API applies: a reader and an archived page may not be
  // commented on. Asking the server would be a second source of truth.
  const canWrite = detail !== null && detail.access === 'write' && detail.archivedAt === null;
  // An ADMIN or OWNER may remove a remark that is not theirs (`canDeleteComment`).
  // Hiding the button for everybody else keeps the panel from offering an action
  // the API would refuse; the API stays the one that decides.
  const role = workspaces.data?.find((workspace) => workspace.id === workspaceId)?.role ?? null;
  const canModerate = role === 'ADMIN' || role === 'OWNER';
  const currentUserId = session.data?.user?.id ?? null;

  const { threads, openCount, resolvedCount } = comments.data;

  return (
    <div className="flex flex-col gap-3" data-testid="comments-panel">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          <span className="exocortex-numeric">{openCount}</span> offen ·{' '}
          <span className="exocortex-numeric">{resolvedCount}</span> erledigt
        </span>
        {canWrite && composing === null ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid="comment-new"
            onClick={() => setComposingPageWide(true)}
          >
            <MessageSquareIcon /> Neu
          </Button>
        ) : null}
      </div>

      {composing === null ? null : (
        <NewThreadComposer
          // Remounting per request empties the field when a different passage
          // is picked, without an effect copying the anchor into state.
          key={editorRequest?.requestId ?? 'page'}
          documentId={documentId}
          anchor={composing}
          onDone={closeComposer}
        />
      )}

      {threads.length === 0 ? (
        <EmptyState
          title="Noch keine Kommentare"
          description={
            canWrite
              ? 'Markiere eine Stelle im Text und wähle „Kommentieren“, oder schreibe eine Anmerkung zur ganzen Seite.'
              : 'Zu dieser Seite wurde noch nichts angemerkt.'
          }
          icon={MessageSquareIcon}
        />
      ) : (
        threads.map((thread) => (
          <ThreadCard
            key={thread.root.id}
            thread={thread}
            documentId={documentId}
            currentUserId={currentUserId}
            canWrite={canWrite}
            canModerate={canModerate}
            highlighted={
              highlightedBlockId !== null && thread.root.blockId === highlightedBlockId
            }
          />
        ))
      )}
    </div>
  );
}
