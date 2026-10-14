'use client';

import {
  CheckIcon,
  ChevronDownIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  ShieldMinusIcon,
  XIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { cn, sectionLabelClassName } from '@exocortex/ui';

import { toolActivityLine, useRunLabels } from './run-labels';
import { hasReasoning, type RunTraceStep, toolEntries } from './run-trace';
import { type ToolActivityEntry } from './use-ai-run-tracker';

export interface RunTraceViewProps {
  steps: readonly RunTraceStep[];
  /** The run is still going: the trace is open, follows the newest line and says so. */
  live: boolean;
}

const STATUS_ICON: Record<ToolActivityEntry['status'], typeof CheckIcon> = {
  started: LoaderCircleIcon,
  succeeded: CheckIcon,
  failed: XIcon,
  refused: ShieldMinusIcon,
  retried: RotateCcwIcon,
};

/**
 * What the model did on the way to its answer (issue #195): its thinking,
 * when the provider streamed any, and the tool calls between, in order.
 *
 * Named after what it holds. "Gedankengang" only when real reasoning arrived,
 * "Aktivitäten" when there were tool calls and nothing else, and no section at
 * all for a run that did neither, so the heading never promises thinking a
 * model did not show. Open while the run is live and folded once it ended,
 * unless the reader decided otherwise for this run.
 *
 * Out of the transcript's `aria-live` log on purpose: the thinking streams a
 * few words at a time, and a screen reader would otherwise read every one of
 * them aloud over the answer.
 */
export function RunTraceView({ steps, live }: RunTraceViewProps) {
  const t = useTranslations('ai.trace');
  const runLabel = useRunLabels();
  const bodyId = React.useId();
  const bodyRef = React.useRef<HTMLOListElement | null>(null);
  const followRef = React.useRef(true);
  const [override, setOverride] = React.useState<boolean | null>(null);
  const open = override ?? live;

  const reasoned = hasReasoning(steps);
  const tools = toolEntries(steps).filter((entry) => entry.status !== 'retried');
  const lastStep = steps[steps.length - 1];
  const textLength = lastStep?.kind === 'reasoning' ? lastStep.text.length : 0;

  // Follows the newest line while it streams, until the reader scrolls up to
  // read something earlier; scrolling back to the bottom resumes following.
  React.useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null || !live || !followRef.current) return;
    body.scrollTop = body.scrollHeight;
  }, [live, open, steps.length, textLength]);

  if (steps.length === 0) return null;

  const status = live
    ? t('live')
    : tools.length > 0
      ? t('toolCount', { count: tools.length })
      : null;

  return (
    <section className="flex flex-col gap-1.5" data-testid="ai-run-trace" aria-live="off">
      <button
        type="button"
        // Concatenated rather than passed through `cn`: tailwind-merge takes
        // `text-micro` and `text-muted-foreground` for the same property and
        // drops the size, which left this label at 16 px.
        className={`flex w-fit max-w-full items-center gap-2 rounded-sm transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${sectionLabelClassName}`}
        aria-expanded={open}
        aria-controls={bodyId}
        data-testid="ai-run-trace-toggle"
        onClick={() => setOverride(!open)}
      >
        <ChevronDownIcon
          aria-hidden
          className={cn('size-3.5 transition-transform', open ? 'rotate-180' : undefined)}
        />
        {reasoned ? t('reasoningTitle') : t('activityTitle')}
        <span className="h-px w-6 shrink-0 bg-signal-line" aria-hidden />
        {status === null ? null : (
          <span className="flex items-center gap-1.5 tracking-normal whitespace-nowrap normal-case">
            {live ? (
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse"
              />
            ) : null}
            <span>{status}</span>
          </span>
        )}
      </button>

      {open ? (
        <ol
          id={bodyId}
          ref={bodyRef}
          className="flex max-h-72 flex-col gap-2 overflow-y-auto overscroll-contain"
          data-testid="ai-run-trace-steps"
          onScroll={(event) => {
            const body = event.currentTarget;
            followRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 16;
          }}
        >
          {steps.map((step) =>
            step.kind === 'reasoning' ? (
              <li
                key={step.key}
                className="relative pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground"
                data-testid="ai-run-trace-reasoning"
              >
                <span aria-hidden className="absolute inset-y-0.5 left-0.5 w-px bg-signal-line" />
                {step.text.trim()}
              </li>
            ) : (
              <ToolStep
                key={step.key}
                entry={step.entry}
                label={runLabel(toolActivityLine(step.entry))}
              />
            ),
          )}
          {reasoned && !live ? (
            <li className="text-micro text-muted-foreground">{t('notStored')}</li>
          ) : null}
        </ol>
      ) : null}
    </section>
  );
}

function ToolStep({ entry, label }: { entry: ToolActivityEntry; label: string }) {
  const Icon = STATUS_ICON[entry.status];
  return (
    <li
      className={cn(
        'flex items-start gap-1.5 text-xs',
        entry.status === 'failed' ? 'text-destructive-text' : 'text-muted-foreground',
      )}
      data-testid="ai-run-trace-tool"
      data-status={entry.status}
    >
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-3 shrink-0',
          entry.status === 'started' ? 'motion-safe:animate-spin' : undefined,
        )}
      />
      <span className="min-w-0 break-words">{label}</span>
    </li>
  );
}
