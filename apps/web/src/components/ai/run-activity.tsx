'use client';

import { BookOpenIcon, FilePenLineIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button, cn } from '@exocortex/ui';

import { useDocument } from '@/lib/api/document-queries';
import { documentHref } from '@/lib/document-href';

export interface RunActivityProps {
  /** What the run is doing right now, e.g. "Werkzeug exo_page_write (Seite abc) wird ausgeführt". */
  phaseLabel: string;
  elapsedMs: number;
  /** True once `elapsedMs` crosses the quiet threshold: the pulse alone stops being enough. */
  quiet: boolean;
  /** A gap in `ai.run.progress`'s `sequence` was detected; the preview was reloaded from the run. */
  gapDetected: boolean;
  onCancel: () => void;
  cancelling: boolean;
  /**
   * The page the run's latest tool call is about (issue #248), so the reader
   * sees where the run is working and can go there.
   */
  page?: { documentId: string; writing: boolean } | null;
}

/** Minutes and zero-padded seconds, or `null` minutes below one minute. */
function splitElapsed(ms: number): { minutes: number | null; seconds: string } {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return { minutes: null, seconds: String(totalSeconds) };
  const seconds = totalSeconds % 60;
  return { minutes: Math.floor(totalSeconds / 60), seconds: seconds.toString().padStart(2, '0') };
}

/**
 * The run's pulse: visible for as long as a run is active, so the panel never
 * goes quiet without saying so (issue #6). Kept out of the transcript's
 * `aria-live` log on purpose -- a counter that changes every second would
 * otherwise re-announce itself to screen readers once a second.
 */
export function RunActivity({
  phaseLabel,
  elapsedMs,
  quiet,
  gapDetected,
  onCancel,
  cancelling,
  page = null,
}: RunActivityProps) {
  const t = useTranslations('ai.run');
  const { minutes, seconds } = splitElapsed(elapsedMs);
  const elapsed =
    minutes === null
      ? t('elapsedSeconds', { seconds })
      : t('elapsedMinutes', { minutes: String(minutes), seconds });
  return (
    <div
      data-testid="ai-run-activity"
      className={cn(
        'flex flex-col gap-1 border-t px-2 py-1.5 text-xs',
        quiet
          ? 'border-warning/40 bg-warning/10 text-warning'
          : 'border-border text-muted-foreground',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 animate-pulse rounded-full',
            quiet ? 'bg-warning' : 'bg-primary',
          )}
        />
        <span
          className={cn('min-w-0 flex-1 truncate', quiet && 'font-medium')}
          data-testid="ai-run-phase"
        >
          {t('since', { phase: phaseLabel, elapsed })}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={cancelling}
          data-testid="ai-cancel-run"
        >
          <XIcon aria-hidden />
          {cancelling ? t('cancelling') : t('cancel')}
        </Button>
      </div>
      {/* Past the threshold the line stops being a decorative pulse and says
          what a long silence actually means: still allowed, still cancellable.
          Without this, a legitimate three-minute tool call and a dead run look
          exactly alike. */}
      {page === null ? null : <RunPageLine documentId={page.documentId} writing={page.writing} />}
      {quiet ? <p data-testid="ai-run-quiet-hint">{t('quietHint')}</p> : null}
      {gapDetected ? <p data-testid="ai-run-gap-hint">{t('gapHint')}</p> : null}
    </div>
  );
}

/**
 * "Schreibt in „Titel“" or "Liest „Titel“", linked (issue #248). It names
 * where the run's latest call went, nothing more: there is no "being edited"
 * state on the page itself (ADR-065), and a write still lands as one
 * transaction whose blocks the editor then marks. A page the reader cannot
 * open is named without a title and without a link.
 */
function RunPageLine({ documentId, writing }: { documentId: string; writing: boolean }) {
  const t = useTranslations('ai.run.page');
  const document = useDocument(documentId);
  const Icon = writing ? FilePenLineIcon : BookOpenIcon;
  const title = document.data?.title;
  const text =
    title === undefined
      ? t(writing ? 'writingUnknown' : 'readingUnknown')
      : t(writing ? 'writing' : 'reading', { title: title.length > 0 ? title : t('untitled') });
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 pl-3.5"
      data-testid="ai-run-page"
      data-writing={writing ? 'true' : 'false'}
      data-document-id={documentId}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      {document.data === undefined ? (
        <span className="truncate">{text}</span>
      ) : (
        <Link
          href={documentHref(document.data.workspaceId, documentId, document.data.type)}
          className="truncate underline-offset-2 hover:text-foreground hover:underline"
        >
          {text}
        </Link>
      )}
    </div>
  );
}
