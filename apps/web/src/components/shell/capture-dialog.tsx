'use client';

import { ArrowRightIcon, InboxIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { type CaptureResponse } from '@exocortex/contracts';
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
  Input,
  Label,
  Textarea,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useCapture } from '@/lib/api/inbox-queries';

/**
 * Quick capture (issue #71, ADR-036).
 *
 * The dialog stays open after a capture and clears its field instead of
 * closing: capture happens in bursts, and having to press the shortcut again
 * between two thoughts is exactly the friction this exists to remove. The
 * confirmation stays on screen with a link, so the page is one click away
 * without being a detour.
 *
 * There is no place picker and there will not be one. Choosing where something
 * goes is the expensive half; postponing it is the feature.
 */
export function CaptureDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = React.useState('');
  const [sourceUrl, setSourceUrl] = React.useState('');
  const [last, setLast] = React.useState<CaptureResponse | null>(null);
  const capture = useCapture(workspaceId);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  /*
   * Closing is what empties the dialog. A dialog that reopens holding the
   * previous confirmation reads as if the capture had just happened again, and
   * resetting on *open* would be a state update inside an effect for a state
   * change that is already an event. Every way out goes through here: Escape,
   * the button, the backdrop, and the shortcut, which only ever opens.
   */
  const changeOpen = (next: boolean): void => {
    if (!next) {
      setLast(null);
      setText('');
      setSourceUrl('');
    }
    onOpenChange(next);
  };

  const submit = (): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || capture.isPending) return;
    const url = sourceUrl.trim();
    void capture
      .mutateAsync({ text: trimmed, ...(url.length > 0 ? { sourceUrl: url } : {}) })
      .then((result) => {
        setLast(result);
        setText('');
        setSourceUrl('');
        textareaRef.current?.focus();
      })
      .catch(() => {
        // Rendered from `capture.isError` below; the text stays in the field so
        // nothing typed is lost.
      });
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent data-testid="capture-dialog">
        <DialogHeader>
          <DialogTitle>Erfassen</DialogTitle>
          <DialogDescription>
            Landet im Eingang. Die erste Zeile wird zum Titel, einsortiert wird später.
          </DialogDescription>
        </DialogHeader>

        {capture.isError ? (
          <Alert variant="destructive" data-testid="capture-error">
            <AlertDescription>
              {messageForCode(capture.error instanceof ApiError ? capture.error.code : undefined)}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-3">
          <Textarea
            ref={textareaRef}
            autoFocus
            rows={6}
            value={text}
            placeholder="Was willst du dir merken?"
            aria-label="Notiz"
            data-testid="capture-text"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="capture-source">Quelle (optional)</Label>
            <Input
              id="capture-source"
              type="url"
              inputMode="url"
              value={sourceUrl}
              placeholder="https://…"
              data-testid="capture-source"
              onChange={(event) => setSourceUrl(event.target.value)}
            />
          </div>
        </div>

        {last === null ? null : (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <InboxIcon className="size-4 shrink-0" />
            <span className="truncate">Erfasst: {last.document.title}</span>
            <Link
              href={`/arbeitsbereich/${workspaceId}/seite/${last.document.id}`}
              className="ml-auto flex shrink-0 items-center gap-1 text-foreground hover:underline"
              data-testid="capture-open"
              onClick={() => changeOpen(false)}
            >
              Öffnen <ArrowRightIcon className="size-3.5" />
            </Link>
          </p>
        )}

        <DialogFooter>
          <span className="mr-auto flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              Speichern mit <kbd className="exocortex-numeric">Strg</kbd> +{' '}
              <kbd className="exocortex-numeric">Enter</kbd>
            </span>
            {/* The one place where somebody is already thinking about capture,
                which is the only moment a browser bookmarklet sounds useful. */}
            <Link
              href="/teilen"
              className="hover:underline"
              data-testid="open-clipper"
              onClick={() => changeOpen(false)}
            >
              Web Clipper
            </Link>
          </span>
          <Button variant="ghost" onClick={() => changeOpen(false)}>
            Schließen
          </Button>
          <Button
            onClick={submit}
            disabled={text.trim().length === 0 || capture.isPending}
            data-testid="capture-submit"
          >
            Erfassen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
