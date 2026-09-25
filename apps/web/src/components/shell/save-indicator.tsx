'use client';

import { useFormatter, useTranslations } from 'next-intl';

import { cn } from '@exocortex/ui';

import { useDocumentSession } from './document-session';

/**
 * The save heartbeat.
 *
 * This is the one place in the product where amber marks an *event* rather than
 * a place: when an edit reaches the collaboration server the dot fires and
 * decays back to rest. Everything else that is amber means "you can act here";
 * this means "it just happened".
 *
 * The beat is a pure CSS animation restarted by keying the dot on the save
 * timestamp, so no React state and no effect are involved. Under
 * `prefers-reduced-motion` the global base layer collapses the animation to its
 * end state, which is exactly the resting dot; the timestamp carries the same
 * information without motion and without colour.
 *
 * There is deliberately no live region: announcing every save would make the
 * page unusable with a screen reader.
 */
export function SaveIndicator() {
  const { state } = useDocumentSession();
  const t = useTranslations('shell.saveIndicator');
  const format = useFormatter();

  if (state.documentId === null) return null;

  // Offline and queued edits are the connection indicator's job. Here the only
  // honest statement is that the edit exists locally.
  const local = state.offline || state.pendingSync;
  const savedAt = state.savedAt;
  const settled = savedAt !== null && !local && state.saveState === 'saved';

  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
      data-testid="save-indicator"
      data-save-state={local ? 'local' : state.saveState}
    >
      <span
        key={savedAt ?? 'idle'}
        aria-hidden
        className={cn('size-1.5 rounded-full bg-muted-foreground/50', settled && 'exocortex-beat')}
      />
      {local
        ? t('local')
        : !settled
          ? t('saved')
          : t.rich('savedAt', {
              clock: format.dateTime(savedAt, { hour: '2-digit', minute: '2-digit' }),
              time: (chunks) => <span className="exocortex-numeric">{chunks}</span>,
            })}
    </span>
  );
}
