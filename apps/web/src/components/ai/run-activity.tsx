'use client';

import { XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button, cn } from '@exocortex/ui';

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
      {quiet ? <p data-testid="ai-run-quiet-hint">{t('quietHint')}</p> : null}
      {gapDetected ? <p data-testid="ai-run-gap-hint">{t('gapHint')}</p> : null}
    </div>
  );
}
