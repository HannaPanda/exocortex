'use client';

import { CloudOffIcon, RefreshCwIcon, SignalHighIcon, SignalZeroIcon } from 'lucide-react';
import * as React from 'react';

import { Badge, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

import { useRealtime } from '@/lib/realtime/realtime-provider';

import { useDocumentSession } from './document-session';

/**
 * Shows the state of both channels: the application socket and the collaboration
 * connection, plus the browser's offline state.
 */
export function ConnectionStatus() {
  const { status } = useRealtime();
  const { state } = useDocumentSession();

  const offline = state.offline;
  const collaboration = state.collaboration;

  const { icon, label, variant } = React.useMemo(() => {
    if (offline) {
      return {
        icon: <CloudOffIcon aria-hidden />,
        label: 'Offline – Änderungen werden lokal gespeichert',
        variant: 'destructive' as const,
      };
    }
    if (status === 'connected' && (collaboration === 'connected' || state.documentId === null)) {
      return {
        icon: <SignalHighIcon aria-hidden />,
        label: 'Verbunden',
        variant: 'muted' as const,
      };
    }
    if (status === 'disconnected' || collaboration === 'disconnected') {
      return {
        icon: <SignalZeroIcon aria-hidden />,
        label: 'Verbindung unterbrochen – wird erneut versucht',
        variant: 'destructive' as const,
      };
    }
    return {
      icon: <RefreshCwIcon className="animate-spin" aria-hidden />,
      label: 'Verbindung wird aufgebaut …',
      variant: 'muted' as const,
    };
  }, [collaboration, offline, state.documentId, status]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant={variant}
            className="gap-1 px-1.5"
            data-testid="connection-status"
            // The label alone cannot be read back: "Verbunden" is also what a
            // page with no document open shows, so anything waiting for the
            // editing session to be live would be satisfied too early. These
            // two say which channel is in which state, separately.
            data-app-socket={status}
            data-collaboration={state.documentId === null ? 'none' : collaboration}
          >
            {icon}
            <span className="exocortex-sr-only">{label}</span>
            {state.pendingSync ? (
              <span className="text-[0.625rem]" data-testid="pending-sync">
                offline-Änderungen
              </span>
            ) : null}
          </Badge>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
