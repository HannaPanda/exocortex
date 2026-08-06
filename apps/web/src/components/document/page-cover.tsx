'use client';

import { CheckIcon, ImageIcon, MoveVerticalIcon, Trash2Icon, XIcon } from 'lucide-react';
import * as React from 'react';

import { Button, cn } from '@exocortex/ui';

import { useUpdateDocument, useUploadDocumentCover } from '@/lib/api/queries';

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
export function PageCoverAddButton({ workspaceId, documentId, className }: PageCoverAddButtonProps) {
  const { input, choose, upload } = useCoverPicker(workspaceId, documentId);

  return (
    <div className={cn('flex h-8 items-center gap-2', className)}>
      {input}
      <Button
        variant="ghost"
        size="sm"
        disabled={upload.isPending}
        data-testid="add-cover"
        // Hidden until the page is hovered, so an empty page carries no control
        // for something it does not have. A touch device has no hover to give,
        // so there the button simply stays visible.
        className="text-muted-foreground opacity-0 transition-opacity group-hover/page:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100"
        onClick={choose}
      >
        <ImageIcon /> {upload.isPending ? 'Wird hochgeladen …' : 'Titelbild hinzufügen'}
      </Button>
      {upload.isError ? (
        <span role="status" className="text-xs text-destructive-text">
          {upload.error.message}
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
  const { input, choose, upload } = useCoverPicker(workspaceId, documentId);
  const updateDocument = useUpdateDocument(workspaceId);

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

  const busy = upload.isPending || updateDocument.isPending;

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
              'aria-label': 'Bildausschnitt senkrecht verschieben',
              'aria-orientation': 'vertical' as const,
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': Math.round(shown),
              'aria-valuetext': `${Math.round(shown)} Prozent von oben`,
            }
          : {})}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- attachment ids are arbitrary user uploads, not build-time-known assets next/image can optimize. */}
        <img
          src={`/api/attachments/${attachmentId}/download`}
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
              <span className="px-2 text-xs text-muted-foreground">
                Ziehen oder Pfeiltasten, dann speichern
              </span>
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                <XIcon /> Abbrechen
              </Button>
              <Button size="sm" disabled={busy} data-testid="save-cover-position" onClick={() => void save()}>
                <CheckIcon /> Speichern
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
                <MoveVerticalIcon /> Position ändern
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} data-testid="replace-cover" onClick={choose}>
                <ImageIcon /> {upload.isPending ? 'Wird hochgeladen …' : 'Ändern'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                data-testid="remove-cover"
                onClick={() => void remove()}
              >
                <Trash2Icon /> Entfernen
              </Button>
            </>
          )}
        </div>
      )}

      {upload.isError ? (
        <p role="status" className="px-6 pt-2 text-xs text-destructive-text">
          {upload.error.message}
        </p>
      ) : null}
    </div>
  );
}
