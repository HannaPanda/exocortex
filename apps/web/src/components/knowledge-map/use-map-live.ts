'use client';

import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { knowledgeMapKey } from '@/lib/api/knowledge-map-queries';
import { useRealtimeEvent } from '@/lib/realtime/realtime-provider';

import { documentIdOfSubject, type PulseKind } from './map-model';

/** One line of the live feed beside the map. */
export interface MapActivity {
  id: number;
  kind: PulseKind;
  documentId: string;
  at: number;
}

const FEED_LENGTH = 6;
/** A run reads in bursts; the camera visits at most one page in this time. */
const FOLLOW_INTERVAL_MS = 2_800;
/** Materialization rewrites references a moment after the write that caused it. */
const REFETCH_DELAY_MS = 900;
/** A removed point flashes red before the refetch takes it away. */
const REMOVAL_DELAY_MS = 1_900;

export interface MapLiveInput {
  workspaceId: string;
  /** Called for every page something just happened to. */
  onPulse: (documentId: string, kind: PulseKind) => void;
  /** Called when the camera should visit a page a run is touching. */
  onFollow: (documentId: string) => void;
  follow: boolean;
}

/**
 * Turns the workspace's events into what the map shows (issue #189).
 *
 * A run's tool calls arrive on the application socket with the page they are
 * about (`subject`), so a read lights a point blue and a write amber while it
 * happens. A write from an external agent arrives as `document.content.replaced`
 * and lights up the same way. Everything that changes points or lines asks the
 * API for the map again, debounced, and the merge lets the new parts flash.
 */
export function useMapLive({
  workspaceId,
  onPulse,
  onFollow,
  follow,
}: MapLiveInput): MapActivity[] {
  const queryClient = useQueryClient();
  const [feed, setFeed] = React.useState<MapActivity[]>([]);
  const counter = React.useRef(0);
  const lastFollow = React.useRef(0);
  const refetchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = React.useRef({ onPulse, onFollow, follow });
  React.useEffect(() => {
    latest.current = { onPulse, onFollow, follow };
  }, [onPulse, onFollow, follow]);

  React.useEffect(
    () => () => {
      if (refetchTimer.current !== null) clearTimeout(refetchTimer.current);
    },
    [],
  );

  const refetchSoon = React.useCallback(
    (delay = REFETCH_DELAY_MS) => {
      if (refetchTimer.current !== null) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => {
        refetchTimer.current = null;
        void queryClient.invalidateQueries({ queryKey: knowledgeMapKey(workspaceId) });
      }, delay);
    },
    [queryClient, workspaceId],
  );

  const happened = React.useCallback((documentId: string, kind: PulseKind) => {
    latest.current.onPulse(documentId, kind);
    counter.current += 1;
    const entry = { id: counter.current, kind, documentId, at: Date.now() };
    setFeed((previous) => [entry, ...previous].slice(0, FEED_LENGTH));
    const now = Date.now();
    if (
      latest.current.follow &&
      (kind === 'read' || kind === 'write') &&
      now - lastFollow.current > FOLLOW_INTERVAL_MS
    ) {
      lastFollow.current = now;
      latest.current.onFollow(documentId);
    }
  }, []);

  const mine = (event: { workspaceId: string }): boolean => event.workspaceId === workspaceId;

  useRealtimeEvent('ai.run.tool_call', (event) => {
    if (!mine(event)) return;
    const documentId = documentIdOfSubject(event.payload.subject);
    if (documentId === null) return;
    const writes = event.payload.target === event.payload.subject;
    if (event.payload.status === 'started') happened(documentId, writes ? 'write' : 'read');
    else if (event.payload.status === 'succeeded' && writes) refetchSoon();
  });
  useRealtimeEvent('document.content.replaced', (event) => {
    if (!mine(event)) return;
    happened(event.payload.documentId, 'write');
  });
  useRealtimeEvent('document.created', (event) => {
    if (!mine(event)) return;
    // The point does not exist yet; the merge after the refetch lets it flash.
    counter.current += 1;
    const entry = {
      id: counter.current,
      kind: 'created' as const,
      documentId: event.payload.document.id,
      at: Date.now(),
    };
    setFeed((previous) => [entry, ...previous].slice(0, FEED_LENGTH));
    refetchSoon(300);
  });
  useRealtimeEvent('document.archived', (event) => {
    if (!mine(event)) return;
    happened(event.payload.document.id, 'removed');
    refetchSoon(REMOVAL_DELAY_MS);
  });
  useRealtimeEvent('document.deleted', (event) => {
    if (!mine(event)) return;
    for (const id of event.payload.documentIds) latest.current.onPulse(id, 'removed');
    happened(event.payload.documentId, 'removed');
    refetchSoon(REMOVAL_DELAY_MS);
  });
  useRealtimeEvent('document.updated', (event) => {
    if (mine(event)) refetchSoon();
  });
  useRealtimeEvent('document.moved', (event) => {
    if (mine(event)) refetchSoon();
  });
  useRealtimeEvent('document.restored', (event) => {
    if (mine(event)) refetchSoon();
  });
  useRealtimeEvent('document.materialized', (event) => {
    if (mine(event)) refetchSoon(1_500);
  });

  return feed;
}
