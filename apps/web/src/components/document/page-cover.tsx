'use client';

import {
  CheckIcon,
  ImageIcon,
  LoaderCircleIcon,
  MoveVerticalIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentCoverErrorDetail } from '@exocortex/contracts';
import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
} from '@exocortex/ui';

import { usePaletteRequest } from '@/components/palette/palette-requests';
import { useGenerateDocumentCover, useUploadDocumentCover } from '@/lib/api/cover-queries';
import { useUpdateDocument } from '@/lib/api/document-queries';
import { useRealtimeEvent } from '@/lib/realtime/realtime-provider';
import { usePersistentState } from '@/lib/use-persistent-state';

/**
 * The `accept` filter is the image half of `ALLOWED_ATTACHMENT_MIME_TYPES`. It
 * is a convenience for the file dialog, not a check: the API sniffs the real
 * type from the magic bytes and rejects anything that is not an image.
 */
const COVER_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml';

/** How far a full-height drag moves the crop. */
const DRAG_RANGE_PERCENT = 100;
/** One arrow key press. */
const KEY_STEP_PERCENT = 2;

function clampPosition(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Hidden file input plus the upload mutation, shared by the two places a cover
 * can be chosen: the button on a page without one, and "Ändern" on a page with
 * one.
 */
function useCoverPicker(workspaceId: string, documentId: string) {
  const upload = useUploadDocumentCover(workspaceId);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={COVER_ACCEPT}
      className="hidden"
      data-testid="cover-file-input"
      onChange={(event) => {
        const file = event.target.files?.[0];
        // Reset first: picking the same file twice in a row fires no change
        // event otherwise.
        event.target.value = '';
        if (file === undefined) return;
        void upload.mutateAsync({ documentId, file }).catch(() => {
          // Reported through `upload.error` below; a rejected promise here
          // would only become an unhandled rejection.
        });
      }}
    />
  );

  return { input, choose: () => inputRef.current?.click(), upload };
}

/**
 * "Titelbild hochladen" and "Titelbild erzeugen" from the palette reach the
 * same file input and prompt dialog as the buttons.
 */
function useCoverRequests(choose: () => void, openPrompt: () => void, enabled: boolean): void {
  usePaletteRequest('upload-cover', choose, enabled);
  usePaletteRequest('generate-cover', openPrompt, enabled);
}

/** A failed cover in the reader's language, from the worker's code (issue #98). */
function coverErrorText(
  t: ReturnType<typeof useTranslations<'document.cover'>>,
  detail: DocumentCoverErrorDetail,
): string {
  switch (detail.code) {
    case 'no_picture':
      return t('generationErrors.no_picture', { model: detail.model });
    case 'key_refused':
      // Whose key and why (issue #252): nothing stepped in for it, so the
      // reader has to know who can fix it.
      return t(
        `generationErrors.key_refused.${detail.reason}${detail.ownKey ? 'OwnKey' : 'DeploymentKey'}`,
      );
    case 'key_unreadable':
      // The workspace's own key cannot be read (issue #260): nothing was
      // drawn, nothing stepped in, and the reason says who can fix it.
      return t(`generationErrors.key_unreadable.${detail.reason}`);
    default:
      return t(`generationErrors.${detail.code}`);
  }
}

/**
 * The AI half: send a prompt, then wait for the worker to say it is over.
 *
 * The request only queues the work, so "pending" cannot come from the mutation
 * — it ends immediately. It ends when `document.cover.generated` arrives for
 * this page, which also carries the reason as a code when the drawing failed.
 */
function useCoverGeneration(documentId: string) {
  const t = useTranslations('document.cover');
  const generate = useGenerateDocumentCover();
  const [pending, setPending] = React.useState(false);
  // The failure is kept as the worker's code and worded while rendering, so a
  // message still on screen follows a change of language (issue #98). `text`
  // is for a failed request, whose `message` resolves itself, and for a
  // worker older than the codes.
  const [failure, setFailure] = React.useState<
    { detail: DocumentCoverErrorDetail } | { text: string } | null
  >(null);

  useRealtimeEvent('document.cover.generated', (event) => {
    if (event.payload.documentId !== documentId) return;
    setPending(false);
    const { error, errorDetail } = event.payload;
    setFailure(
      errorDetail !== null ? { detail: errorDetail } : error !== null ? { text: error } : null,
    );
  });

  const start = async (draft: CoverDraft): Promise<void> => {
    setFailure(null);
    setPending(true);
    try {
      await generate.mutateAsync({
        documentId,
        prompt: draft.prompt.trim(),
        pageContext: draft.pageContext,
      });
    } catch (cause) {
      setPending(false);
      setFailure({ text: cause instanceof Error ? cause.message : t('requestFailed') });
    }
  };

  const error =
    failure === null ? null : 'text' in failure ? failure.text : coverErrorText(t, failure.detail);

  return { pending, error, start };
}

/** What the prompt dialog remembers for a page (issue #224). */
interface CoverDraft {
  prompt: string;
  /** "Kontext aus der Seite": title, headings and summary go to the model too. */
  pageContext: boolean;
}

const EMPTY_DRAFT: CoverDraft = { prompt: '', pageContext: false };

function parseDraft(raw: string): CoverDraft {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) return EMPTY_DRAFT;
  const { prompt, pageContext } = value as Record<string, unknown>;
  return {
    prompt: typeof prompt === 'string' ? prompt.slice(0, 1_000) : '',
    pageContext: pageContext === true,
  };
}

/**
 * The prompt and the context choice, kept per page in this browser (issue
 * #224). A prompt survives closing the dialog, sending it, a failed picture,
 * the swap from "add" to "regenerate" once the first cover is there, and a
 * reload, so trying a variation means changing a word rather than retyping
 * the idea. It stays on the device and never reaches the server until it is
 * sent; where the browser refuses storage, it lives for the tab
 * (`usePersistentState`). An empty field is how a person forgets it.
 */
function useCoverDraft(documentId: string): [CoverDraft, (draft: CoverDraft) => void] {
  return usePersistentState(`exocortex.cover.draft.${documentId}`, EMPTY_DRAFT, parseDraft);
}

/** The shortest prompt the API accepts on its own, without the page context. */
const MIN_PROMPT_CHARS = 3;

interface CoverPromptDialogProps {
  documentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: CoverDraft) => void;
}

/**
 * Asks what the picture should show: in the person's words, from the page
 * itself, or both. The page context is a choice made each time it is wanted
 * and remembered with the prompt, never a default, because it sends page text
 * to the image model.
 */
function CoverPromptDialog({ documentId, open, onOpenChange, onSubmit }: CoverPromptDialogProps) {
  const t = useTranslations('document.cover');
  const [draft, setDraft] = useCoverDraft(documentId);
  const ready = draft.pageContext || draft.prompt.trim().length >= MIN_PROMPT_CHARS;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('promptTitle')}</DialogTitle>
          <DialogDescription>{t('promptDescription')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="cover-prompt">
            {draft.pageContext ? t('promptLabelOptional') : t('promptLabel')}
          </Label>
          <Textarea
            id="cover-prompt"
            rows={4}
            maxLength={1_000}
            data-testid="cover-prompt-input"
            placeholder={t('promptPlaceholder')}
            value={draft.prompt}
            onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
          />
        </div>
        {/* One label around box and words, so the whole line is the hit target. */}
        <label className="flex items-start gap-2">
          <Checkbox
            className="mt-0.5"
            checked={draft.pageContext}
            data-testid="cover-page-context"
            aria-describedby="cover-page-context-hint"
            onCheckedChange={(checked) => setDraft({ ...draft, pageContext: checked === true })}
          />
          <span className="flex flex-col gap-1">
            <span className="text-sm leading-none font-medium">{t('pageContextLabel')}</span>
            <span id="cover-page-context-hint" className="text-xs text-muted-foreground">
              {t('pageContextHint')}
            </span>
          </span>
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            disabled={!ready}
            data-testid="cover-prompt-submit"
            onClick={() => {
              // The draft stays: a picture that did not turn out is retried by
              // changing a word, not by typing the idea again.
              onSubmit(draft);
              onOpenChange(false);
            }}
          >
            <SparklesIcon /> {t('generate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface PageCoverAddButtonProps {
  workspaceId: string;
  documentId: string;
  className?: string;
}

/**
 * "Titelbild hinzufügen" for a page that has none. It stays invisible until the
 * page is hovered or the button is focused, so an empty page does not carry a
 * control for something it does not have.
 */
export function PageCoverAddButton({
  workspaceId,
  documentId,
  className,
}: PageCoverAddButtonProps) {
  const t = useTranslations('document.cover');
  const { input, choose, upload } = useCoverPicker(workspaceId, documentId);
  const generation = useCoverGeneration(documentId);
  const [promptOpen, setPromptOpen] = React.useState(false);
  useCoverRequests(choose, () => setPromptOpen(true), true);

  // Hidden until the page is hovered, so an empty page carries no control for
  // something it does not have. A touch device has no hover to give, so there
  // the buttons simply stay visible — and while a picture is being drawn they
  // stay visible for everyone, because that is the state being reported.
  const revealed = generation.pending
    ? ''
    : 'opacity-0 group-hover/page:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100';
  const busy = upload.isPending || generation.pending;

  return (
    <div className={cn('flex h-8 items-center gap-2', className)}>
      {input}
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        data-testid="add-cover"
        className={cn('text-muted-foreground transition-opacity', revealed)}
        onClick={choose}
      >
        <ImageIcon /> {upload.isPending ? t('uploading') : t('add')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        data-testid="generate-cover"
        className={cn('text-muted-foreground transition-opacity', revealed)}
        onClick={() => setPromptOpen(true)}
      >
        <SparklesIcon /> {generation.pending ? t('generating') : t('generateWithAi')}
      </Button>
      <CoverPromptDialog
        documentId={documentId}
        open={promptOpen}
        onOpenChange={setPromptOpen}
        onSubmit={(draft) => void generation.start(draft)}
      />
      {upload.isError || generation.error !== null ? (
        <span role="alert" className="text-xs text-destructive-text">
          {generation.error ?? upload.error?.message}
        </span>
      ) : null}
    </div>
  );
}

export interface PageCoverProps {
  workspaceId: string;
  documentId: string;
  attachmentId: string;
  position: number;
  readOnly: boolean;
}

/**
 * A label in the cover's menu: printed where the cover is wide enough, and on
 * a narrow one left to screen readers and the button's tooltip, so the four
 * controls fit a phone as icons (issue #266).
 */
function CoverLabel({ children }: { children: React.ReactNode }) {
  return <span className="sr-only @min-[36rem]/cover:not-sr-only">{children}</span>;
}

/**
 * The cover image above the page title: full width, fixed height, cropped with
 * `object-fit: cover`.
 *
 * The only framing decision is vertical, exactly as in Notion, and for the same
 * reason: a cover of a fixed height looks the same on every page, so the one
 * thing worth choosing is which slice of the image it shows. Free scaling and
 * horizontal panning would buy variation nobody asked for and a second way for
 * a page to look wrong.
 *
 * While repositioning, the image itself is the control (`role="slider"`): drag
 * it with a pointer, or move it with the arrow keys once it has focus. A
 * separate track would be a second thing to aim at for a gesture that is
 * already about the image.
 */
export function PageCover({
  workspaceId,
  documentId,
  attachmentId,
  position,
  readOnly,
}: PageCoverProps) {
  const t = useTranslations('document.cover');
  const { input, choose, upload } = useCoverPicker(workspaceId, documentId);
  const updateDocument = useUpdateDocument(workspaceId);
  const generation = useCoverGeneration(documentId);
  const [promptOpen, setPromptOpen] = React.useState(false);
  useCoverRequests(choose, () => setPromptOpen(true), !readOnly);

  // Non-null means "repositioning": the draft is what the page shows, and the
  // stored position is what it falls back to on cancel.
  const [draft, setDraft] = React.useState<number | null>(null);
  const dragRef = React.useRef<{ pointerId: number; startY: number; startPosition: number } | null>(
    null,
  );
  const frameRef = React.useRef<HTMLDivElement>(null);

  const shown = draft ?? position;
  const repositioning = draft !== null;

  const save = async (): Promise<void> => {
    if (draft === null) return;
    await updateDocument.mutateAsync({ documentId, request: { coverPosition: draft } });
    setDraft(null);
  };

  const remove = async (): Promise<void> => {
    setDraft(null);
    await updateDocument.mutateAsync({ documentId, request: { coverAttachmentId: null } });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!repositioning || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startPosition: shown };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const height = frameRef.current?.clientHeight ?? 1;
    // Dragging the image up reveals what is below it, which is a *higher*
    // percentage of the source image. Hence the minus.
    const delta = ((drag.startY - event.clientY) / height) * DRAG_RANGE_PERCENT;
    setDraft(clampPosition(drag.startPosition + delta));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!repositioning) return;
    const step: Record<string, number> = {
      ArrowUp: -KEY_STEP_PERCENT,
      ArrowDown: KEY_STEP_PERCENT,
      PageUp: -10,
      PageDown: 10,
    };
    if (event.key in step) {
      event.preventDefault();
      setDraft(clampPosition(shown + (step[event.key] as number)));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setDraft(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setDraft(100);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(null);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void save();
    }
  };

  const busy = upload.isPending || updateDocument.isPending || generation.pending;

  return (
    // A container, so the menu can ask how wide the cover is rather than the
    // window: below 36rem its labels go to screen readers and tooltips only
    // (issue #266, the menu ran off the left edge of a phone). No `w-full`:
    // its width is the block's own, so the negative margin globals.css gives
    // it beside a pinned outline widens it across that column (issue #267).
    <div
      className="exocortex-page-cover group/cover @container/cover relative"
      data-testid="page-cover"
    >
      {input}
      <div
        ref={frameRef}
        // Notion's ~30vh, kept inside a range so the cover neither disappears on
        // a laptop nor pushes the title off a tall screen.
        className={cn(
          'relative h-[clamp(9rem,30vh,17rem)] w-full overflow-hidden bg-surface',
          repositioning && 'cursor-grab ring-2 ring-ring active:cursor-grabbing',
        )}
        {...(repositioning
          ? {
              role: 'slider' as const,
              tabIndex: 0,
              'aria-label': t('positionLabel'),
              'aria-orientation': 'vertical' as const,
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': Math.round(shown),
              'aria-valuetext': t('positionValue', { percent: Math.round(shown) }),
            }
          : {})}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        {/* oxlint-disable-next-line nextjs/no-img-element -- attachment ids are arbitrary user uploads, not build-time-known assets next/image can optimize. */}
        <img
          // The downscaled copy, which the route falls back to the original for
          // when there is none. A cover is never drawn larger than a wide
          // screen, so the full-size upload is only ever wasted bandwidth here.
          src={`/api/attachments/${attachmentId}/download?variant=preview`}
          alt=""
          draggable={false}
          data-testid="page-cover-image"
          className="size-full touch-none object-cover select-none"
          style={{ objectPosition: `50% ${shown}%` }}
        />
        {/* Always mounted, so a screen reader hears the text arrive in it. */}
        <span role="status" className="sr-only">
          {generation.pending ? t('generatingOverlay') : ''}
        </span>
        {generation.pending ? (
          // The old picture stays until the new one is there (issue #224): it
          // is what the page has, and a failure leaves it exactly as it was.
          // The veil says that it is about to change on the picture itself,
          // not only in the menu, which hides once the pointer leaves.
          <div
            aria-hidden
            data-testid="cover-generating"
            className="absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-[2px]"
          >
            <span className="flex items-center gap-2 rounded-md bg-card/90 px-3 py-1.5 text-sm text-foreground shadow-sm">
              <LoaderCircleIcon className="size-4 motion-safe:animate-spin" />
              {t('generatingOverlay')}
            </span>
          </div>
        ) : null}
      </div>

      {readOnly ? null : (
        <div
          className={cn(
            'absolute right-4 bottom-3 flex max-w-[calc(100%-2rem)] flex-wrap items-center justify-end gap-1 rounded-md bg-card/90 p-1 shadow-sm backdrop-blur transition-opacity',
            'focus-within:opacity-100',
            repositioning
              ? 'opacity-100'
              : 'opacity-0 group-hover/cover:opacity-100 pointer-coarse:opacity-100',
          )}
        >
          {repositioning ? (
            <>
              <span className="px-2 text-xs text-muted-foreground">{t('positionHint')}</span>
              <Button variant="ghost" size="sm" title={t('cancel')} onClick={() => setDraft(null)}>
                <XIcon /> <CoverLabel>{t('cancel')}</CoverLabel>
              </Button>
              <Button
                size="sm"
                disabled={busy}
                title={t('save')}
                data-testid="save-cover-position"
                onClick={() => void save()}
              >
                <CheckIcon /> <CoverLabel>{t('save')}</CoverLabel>
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                title={t('reposition')}
                data-testid="reposition-cover"
                onClick={() => setDraft(position)}
              >
                <MoveVerticalIcon /> <CoverLabel>{t('reposition')}</CoverLabel>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                title={upload.isPending ? t('uploading') : t('replace')}
                data-testid="replace-cover"
                onClick={choose}
              >
                <ImageIcon />{' '}
                <CoverLabel>{upload.isPending ? t('uploading') : t('replace')}</CoverLabel>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                title={generation.pending ? t('generating') : t('regenerate')}
                data-testid="generate-cover"
                onClick={() => setPromptOpen(true)}
              >
                <SparklesIcon />{' '}
                <CoverLabel>{generation.pending ? t('generating') : t('regenerate')}</CoverLabel>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                title={t('remove')}
                data-testid="remove-cover"
                onClick={() => void remove()}
              >
                <Trash2Icon /> <CoverLabel>{t('remove')}</CoverLabel>
              </Button>
            </>
          )}
        </div>
      )}

      <CoverPromptDialog
        documentId={documentId}
        open={promptOpen}
        onOpenChange={setPromptOpen}
        onSubmit={(draft) => void generation.start(draft)}
      />

      {upload.isError || generation.error !== null ? (
        <p role="alert" className="px-6 pt-2 text-xs text-destructive-text">
          {generation.error ?? upload.error?.message}
        </p>
      ) : null}
    </div>
  );
}
