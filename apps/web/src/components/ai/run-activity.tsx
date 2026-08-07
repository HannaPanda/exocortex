'use client';

import { XIcon } from 'lucide-react';

import { Button, cn } from '@exocortex/ui';

export interface RunActivityProps {
  /** What the run is doing right now, e.g. "Werkzeug exo_page_write (Seite abc) wird ausgeführt". */
  phaseLabel: string;
  elapsedMs: number;
  /** True once `elapsedMs` crosses the quiet threshold: the pulse alone stops being enough. */
  quiet: boolean;
  /** A gap in `ai.run.progress`'s `sequence` was detected; the streamed preview may be incomplete. */
  gapDetected: boolean;
  onCancel: () => void;
  cancelling: boolean;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} min ${seconds.toString().padStart(2, '0')} s`;
}

/**
 * The run's pulse: visible for as long as a run is active, so the panel never
 * goes quiet without saying so (issue #6). Kept out of the transcript's
 * `aria-live` log on purpose -- a counter that changes every second would
 * otherwise re-announce itself to screen readers once a second.
 */
export function RunActivity({ phaseLabel, elapsedMs, quiet, gapDetected, onCancel, cancelling }: RunActivityProps) {
  return (
    <div
      data-testid="ai-run-activity"
      className={cn(
        'flex items-center gap-2 border-t px-2 py-1.5 text-xs',
        quiet ? 'border-warning/40 bg-warning/10 text-warning' : 'border-border text-muted-foreground',
      )}
    >
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 animate-pulse rounded-full', quiet ? 'bg-warning' : 'bg-primary')}
      />
      <span className="min-w-0 flex-1 truncate" data-testid="ai-run-phase">
        {phaseLabel} · seit {formatElapsed(elapsedMs)}
        {gapDetected ? ' · Lücke im Text erkannt' : ''}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={onCancel}
        disabled={cancelling}
        data-testid="ai-cancel-run"
      >
        <XIcon aria-hidden />
        {cancelling ? 'Wird abgebrochen …' : 'Abbrechen'}
      </Button>
    </div>
  );
}
