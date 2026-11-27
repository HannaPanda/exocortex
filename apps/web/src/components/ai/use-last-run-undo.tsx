'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AiRunWrittenPages } from '@exocortex/contracts';

import { usePaletteRequest } from '@/components/palette/palette-requests';
import { useRealtime } from '@/lib/realtime/realtime-provider';

import { RunRevertDialog } from './run-revert-dialog';

/**
 * "Letzten KI-Lauf rückgängig machen" from the palette (issue #248).
 *
 * The palette opens the panel and asks; the panel answers with the same
 * preview the line under the answer opens, for the newest run of this
 * conversation that changed a page and has ended. A run still writing has
 * nothing to take back yet, so it is passed over, and a conversation whose
 * runs changed nothing says so instead of opening an empty dialog.
 */
export function useLastRunUndo(input: {
  conversationId: string | null;
  /** The open conversation as the API answered it, once loaded. */
  detail: { runWrites: readonly AiRunWrittenPages[] } | undefined;
  activeRunId: string | null;
  onNothing: (notice: string) => void;
}): React.ReactNode {
  const t = useTranslations('ai.runChanges');
  const [runId, setRunId] = React.useState<string | null>(null);
  const { conversationId, detail, activeRunId, onNothing } = input;

  usePaletteRequest(
    'undo-last-run',
    () => {
      const last = (detail?.runWrites ?? []).findLast((writes) => writes.runId !== activeRunId);
      if (last === undefined) onNothing(t('nothingToUndo'));
      else setRunId(last.runId);
    },
    true,
  );

  if (runId === null) return null;
  return (
    <RunRevertDialog runId={runId} conversationId={conversationId} onClose={() => setRunId(null)} />
  );
}

/**
 * On a shared page the chat runs in one of the reader's own workspaces
 * (ADR-092), which the route does not name, so the shell never joined its
 * room and the run's events had nowhere to arrive. Joining it is the
 * reader's own membership, checked by the gateway like every subscription;
 * it widens nothing, and it is what lets the pulse and the page's hint hear
 * the reader's own run (issue #248).
 */
export function useSharedChatRoom(workspaceId: string, shared: object | null): void {
  const { subscribe } = useRealtime();
  const isShared = shared !== null;
  React.useEffect(() => {
    if (isShared) subscribe(workspaceId);
  }, [isShared, subscribe, workspaceId]);
}
