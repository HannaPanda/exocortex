'use client';

import { CloudOffIcon, RefreshCwIcon, SignalZeroIcon } from 'lucide-react';
import * as React from 'react';

import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

import { useRealtime } from '@/lib/realtime/realtime-provider';

import { useDocumentSession } from './document-session';

/**
 * Shows the state of both channels: the application socket and the collaboration
 * connection, plus the browser's offline state.
 *
 * It speaks the save indicator's language, because the two say related things
 * and sat next to each other saying them differently: a resting dot when there
 * is nothing to report, an icon and a word when there is. A filled pill in the
 * header for "everything is fine" is a control-shaped object marking the
 * absence of news, which is exactly the kind of standing claim on attention
 * PRODUCT.md calls a defect.
 *
 * Colour is never the only carrier: every state that is not "connected" brings
 * an icon and, in the header, German text as well. The full sentence stays in
 * the tooltip and in the screen-reader label at all times.
 */
export function ConnectionStatus() {
  const { status } = useRealtime();
  const { state } = useDocumentSession();

  const offline = state.offline;
  const collaboration = state.collaboration;

  const connection = React.useMemo(() => {
    if (offline) {
      return {
        tone: 'broken' as const,
        icon: CloudOffIcon,
        short: 'offline',
        label: 'Offline: Änderungen werden lokal gespeichert',
      };
    }
    if (status === 'connected' && (collaboration === 'connected' || state.documentId === null)) {
      return { tone: 'resting' as const, icon: null, short: null, label: 'Verbunden' };
    }
    if (status === 'disconnected' || collaboration === 'disconnected') {
      return {
        tone: 'broken' as const,
        icon: SignalZeroIcon,
        short: 'getrennt',
        label: 'Verbindung unterbrochen, wird erneut versucht',
      };
    }
    return {
      tone: 'pending' as const,
      icon: RefreshCwIcon,
      short: null,
      label: 'Verbindung wird aufgebaut …',
    };
  }, [collaboration, offline, state.documentId, status]);

  const Icon = connection.icon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              'flex shrink-0 items-center gap-1.5 text-xs',
              connection.tone === 'broken' ? 'text-destructive-text' : 'text-muted-foreground',
            )}
            data-testid="connection-status"
            // The label alone cannot be read back: "Verbunden" is also what a
            // page with no document open shows, so anything waiting for the
            // editing session to be live would be satisfied too early. These
            // two say which channel is in which state, separately.
            data-app-socket={status}
            data-collaboration={state.documentId === null ? 'none' : collaboration}
          >
            {Icon === null ? (
              // The same resting dot the save indicator settles to. Nothing to
              // report looks like nothing to report.
              <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" />
            ) : (
              <Icon
                aria-hidden
                className={cn('size-3.5', connection.tone === 'pending' && 'animate-spin')}
              />
            )}
            <span className="exocortex-sr-only">{connection.label}</span>
            {connection.short === null ? null : <span>{connection.short}</span>}
            {state.pendingSync ? (
              <span className="text-nano" data-testid="pending-sync">
                offline-Änderungen
              </span>
            ) : null}
          </span>
        }
      />
      <TooltipContent>{connection.label}</TooltipContent>
    </Tooltip>
  );
}
