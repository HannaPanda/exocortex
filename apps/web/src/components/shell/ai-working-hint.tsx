'use client';

import { BotIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { useRealtime, useRealtimeEvent } from '@/lib/realtime/realtime-provider';

import {
  heardFromRun,
  heardToolCall,
  NO_RUN_PRESENCE,
  presenceOn,
  RUN_PRESENCE_SILENCE_MS,
  runEnded,
  type RunPresenceMap,
} from './page-run-presence';

/**
 * Folds the run events this tab hears into "which run is on which page"
 * (issue #248). A clock ticks only while some run is known, so a silent run
 * drops off without anybody waiting for an event that never comes.
 */
function usePageRunPresence(): { presence: RunPresenceMap; now: number } {
  const [presence, setPresence] = React.useState<RunPresenceMap>(NO_RUN_PRESENCE);
  const [now, setNow] = React.useState(() => Date.now());

  useRealtimeEvent('ai.run.tool_call', (event) => {
    setPresence((current) => heardToolCall(current, event.payload, Date.now()));
    setNow(Date.now());
  });
  useRealtimeEvent('ai.run.phase', (event) => {
    setPresence((current) => heardFromRun(current, event.payload.runId, Date.now()));
  });
  useRealtimeEvent('ai.run.progress', (event) => {
    setPresence((current) => heardFromRun(current, event.payload.runId, Date.now()));
  });
  useRealtimeEvent('ai.run.completed', (event) => {
    setPresence((current) => runEnded(current, event.payload.runId));
  });
  useRealtimeEvent('ai.run.failed', (event) => {
    setPresence((current) => runEnded(current, event.payload.runId));
  });

  // A socket that dropped may have missed the end; forget rather than guess.
  // Adjusted during render, React's pattern for state that follows a value.
  const { status } = useRealtime();
  const [seenStatus, setSeenStatus] = React.useState(status);
  if (seenStatus !== status) {
    setSeenStatus(status);
    if (status !== 'connected') setPresence(NO_RUN_PRESENCE);
  }

  const known = presence.size > 0;
  React.useEffect(() => {
    if (!known) return;
    const interval = setInterval(() => setNow(Date.now()), RUN_PRESENCE_SILENCE_MS / 6);
    return () => clearInterval(interval);
  }, [known]);

  return { presence, now };
}

/**
 * "KI arbeitet gerade hier" beside the save indicator (issue #248).
 *
 * A place, not a state: nothing is locked, nothing is stored, and the page
 * keeps taking every keystroke (ADR-065). Shown while a run this tab hears
 * of is on the page with its latest tool call, and gone with its next call
 * elsewhere or its end.
 */
export function AiWorkingHint({ documentId }: { documentId: string }) {
  const t = useTranslations('shell.documentTopBar');
  const { presence, now } = usePageRunPresence();
  const here = presenceOn(presence, documentId, now);
  if (here === null) return null;
  const detail = here.writing ? t('aiWorkingWriting') : t('aiWorkingReading');
  return (
    <span
      role="status"
      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
      title={detail}
      data-testid="ai-working-hint"
      data-writing={here.writing ? 'true' : 'false'}
    >
      <BotIcon aria-hidden className="size-3.5" />
      {/* At phone width the bar has no room for the sentence; the icon stays,
          and a screen reader hears the sentence either way. */}
      <span className="sr-only sm:not-sr-only">{t('aiWorking')}</span>
      <span className="sr-only">{detail}</span>
    </span>
  );
}
