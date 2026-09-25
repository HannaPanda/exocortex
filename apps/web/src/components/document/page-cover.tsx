'use client';

import {
  CheckIcon,
  ImageIcon,
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

import { useGenerateDocumentCover, useUploadDocumentCover } from '@/lib/api/cover-queries';
import { useUpdateDocument } from '@/lib/api/document-queries';
import { useRealtimeEvent } from '@/lib/realtime/realtime-provider';

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

  const start = async (prompt: string): Promise<void> => {
    setFailure(null);
    setPending(true);
    try {
      await generate.mutateAsync({ documentId, prompt });
    } catch (cause) {
      setPending(false);
      setFailure({ text: cause instanceof Error ? cause.message : t('requestFailed') });
    }
  };

  const error =
    failure === null
      ? null
      : 'text' in failure
        ? failure.text
        : failure.detail.code === 'no_picture'
          ? t('generationErrors.no_picture', { model: failure.detail.model })
          : t(`generationErrors.${failure.detail.code}`);

  return { pending, error, start };
}

interface CoverPromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (prompt: string) => void;
}

/** Asks what the picture should show. One field, because there is one input. */
function CoverPromptDialog({ open, onOpenChange, onSubmit }: CoverPromptDialogProps) {
  const t = useTranslations('document.cover');
  const [prompt, setPrompt] = React.useState('');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('promptTitle')}</DialogTitle>
          <DialogDescription>{t('promptDescription')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="cover-prompt">{t('promptLabel')}</Label>
          <Textarea
            id="cover-prompt"
            rows={4}
            maxLength={1_000}
            data-testid="cover-prompt-input"
            placeholder={t('promptPlaceholder')}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            disabled={prompt.trim().length < 3}
            data-testid="cover-prompt-submit"
            onClick={() => {
              onSubmit(prompt.trim());
              setPrompt('');
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
        open={promptOpen}
        onOpenChange={setPromptOpen}
        onSubmit={(prompt) => void generation.start(prompt)}
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
    <div className="group/cover relative w-full" data-testid="page-cover">
      {input}
      <div
        ref={frameRef}
        // Notion's ~30vh, kept inside a range so the cover neither disappears on
        // a laptop nor pushes the title off a tall screen.
        className={cn(
          'h-[clamp(9rem,30vh,17rem)] w-full overflow-hidden bg-surface',
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
      </div>

      {readOnly ? null : (
        <div
          className={cn(
            'absolute right-4 bottom-3 flex items-center gap-1 rounded-md bg-card/90 p-1 shadow-sm backdrop-blur transition-opacity',
            'focus-within:opacity-100',
            repositioning
              ? 'opacity-100'
              : 'opacity-0 group-hover/cover:opacity-100 pointer-coarse:opacity-100',
          )}
        >
          {repositioning ? (
            <>
              <span className="px-2 text-xs text-muted-foreground">{t('positionHint')}</span>
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                <XIcon /> {t('cancel')}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                data-testid="save-cover-position"
                onClick={() => void save()}
              >
                <CheckIcon /> {t('save')}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                data-testid="reposition-cover"
                onClick={() => setDraft(position)}
              >
                <MoveVerticalIcon /> {t('reposition')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                data-testid="replace-cover"
                onClick={choose}
              >
                <ImageIcon /> {upload.isPending ? t('uploading') : t('replace')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                data-testid="generate-cover"
                onClick={() => setPromptOpen(true)}
              >
                <SparklesIcon /> {generation.pending ? t('generating') : t('regenerate')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                data-testid="remove-cover"
                onClick={() => void remove()}
              >
                <Trash2Icon /> {t('remove')}
              </Button>
            </>
          )}
        </div>
      )}

      <CoverPromptDialog
        open={promptOpen}
        onOpenChange={setPromptOpen}
        onSubmit={(prompt) => void generation.start(prompt)}
      />

      {upload.isError || generation.error !== null ? (
        <p role="alert" className="px-6 pt-2 text-xs text-destructive-text">
          {generation.error ?? upload.error?.message}
        </p>
      ) : null}
    </div>
  );
}
