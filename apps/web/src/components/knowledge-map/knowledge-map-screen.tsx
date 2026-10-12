'use client';

import { MonitorXIcon, NetworkIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type KnowledgeMapEdgeKind } from '@exocortex/contracts';
import { Button, EmptyState, ErrorState, LoadingState } from '@exocortex/ui';

import { useKnowledgeMapCommands } from '@/components/palette/knowledge-map-commands';
import { useKnowledgeMap } from '@/lib/api/knowledge-map-queries';

import { MapAppearancePanel } from './map-appearance-panel';
import { MapCanvas } from './map-canvas';
import { type MapEngine } from './map-engine';
import { type MapGraph, mergeGraph, type PulseKind, timelineBounds, tourStops } from './map-model';
import { MapHeader, MapLegend, MapTimeline } from './map-overlays';
import { MapActivityFeed, MapAsk, MapNodeCard, type MapTour, TOUR_STOPS } from './map-panels';
import { useMapAppearance } from './use-map-appearance';
import { useMapLive } from './use-map-live';
import { useMapScreensaver } from './use-map-screensaver';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** The operating system's wish for less motion, read live. False on the server. */
function usePrefersReducedMotion(): boolean {
  return React.useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

const DEFAULT_KINDS: readonly KnowledgeMapEdgeKind[] = ['link', 'similar', 'entity'];

/**
 * The knowledge map (issue #189): every page of the workspace as a point of
 * light, every connection as a line, and the assistant in the shell's panel
 * on the right. Whatever a run or an external agent reads, writes, creates or
 * removes lights up here while it happens.
 */
export function KnowledgeMapScreen({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('knowledgeMap.screen');
  const query = useKnowledgeMap(workspaceId);
  const reducedMotion = usePrefersReducedMotion();

  const [engine, setEngine] = React.useState<MapEngine | null>(null);
  const [unsupported, setUnsupported] = React.useState(false);
  const [graph, setGraph] = React.useState<MapGraph | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [shown, setShown] = React.useState<ReadonlySet<KnowledgeMapEdgeKind>>(
    () => new Set(DEFAULT_KINDS),
  );
  const [moment, setMoment] = React.useState<number | null>(null);
  const [calm, setCalm] = React.useState(false);
  // Off until somebody asks for it: a camera that flies to every read swept
  // the viewer through the cloud until they no longer knew where they were.
  const [follow, setFollow] = React.useState(false);
  const [tour, setTour] = React.useState<MapTour | null>(null);
  const [appearanceOpen, setAppearanceOpen] = React.useState(false);
  const [screensaver, setScreensaver] = React.useState(false);
  const roomRef = React.useRef<HTMLDivElement | null>(null);
  const graphRef = React.useRef<MapGraph | null>(null);
  const appearance = useMapAppearance();
  const openAppearance = React.useCallback(() => setAppearanceOpen(true), []);

  // The screensaver hides the furniture and takes the whole screen when the
  // browser lets it; leaving full screen (Escape does) ends it as well.
  const startScreensaver = React.useCallback(() => {
    setSelected(null);
    setTour(null);
    setAppearanceOpen(false);
    setScreensaver(true);
    void roomRef.current?.requestFullscreen?.().catch(() => undefined);
  }, []);
  const stopScreensaver = React.useCallback(() => {
    setScreensaver(false);
    if (document.fullscreenElement !== null && document.fullscreenElement === roomRef.current) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, []);
  React.useEffect(() => {
    if (!screensaver) return;
    const onChange = (): void => {
      if (document.fullscreenElement === null) setScreensaver(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [screensaver]);
  useKnowledgeMapCommands({ onAppearance: openAppearance, onScreensaver: startScreensaver });

  // A fresh answer is merged into what is on screen, so points keep their
  // place and only the new ones arrive (and flash).
  React.useEffect(() => {
    if (query.data === undefined || engine === null) return;
    const merged = mergeGraph(graphRef.current, query.data);
    graphRef.current = merged.graph;
    engine.setGraph(merged.graph, { nodes: merged.addedNodes, links: merged.addedLinks });
    setGraph(merged.graph);
  }, [query.data, engine]);

  React.useEffect(
    () => engine?.setAppearance(appearance.appearance),
    [engine, appearance.appearance],
  );
  React.useEffect(() => engine?.setShownKinds(shown), [engine, shown]);
  React.useEffect(() => engine?.setMoment(moment), [engine, moment]);
  React.useEffect(() => engine?.setCalm(calm), [engine, calm]);
  React.useEffect(() => engine?.setScreensaver(screensaver), [engine, screensaver]);
  React.useEffect(() => engine?.setSelected(selected), [engine, selected]);
  React.useEffect(() => {
    if (engine === null) return;
    engine.setFocus(tour === null ? null : new Set(tour.stops));
    const stop = tour?.stops[tour.index];
    if (stop !== undefined && selected === null) engine.flyTo(stop, 1_800);
  }, [engine, tour, selected]);

  const byId = React.useMemo(
    () => new Map((graph?.nodes ?? []).map((node) => [node.id, node])),
    [graph],
  );
  const titleOf = React.useCallback((id: string) => byId.get(id)?.title ?? null, [byId]);

  const onPulse = React.useCallback(
    (documentId: string, kind: PulseKind) => engine?.pulse(documentId, kind),
    [engine],
  );
  const onFollow = React.useCallback(
    (documentId: string) => {
      // The reader's own choice comes first: a selected point is not left.
      if (selected === null && tour === null) engine?.flyTo(documentId);
    },
    [engine, selected, tour],
  );
  const feed = useMapLive({ workspaceId, onPulse, onFollow, follow });
  useMapScreensaver({ active: screensaver, graph, onPulse });

  const onResults = React.useCallback(
    (asked: string, hitIds: string[]): boolean => {
      const stops = tourStops(hitIds, new Set(byId.keys()), TOUR_STOPS);
      setSelected(null);
      setTour(stops.length === 0 ? null : { query: asked, stops, index: 0 });
      return stops.length > 0;
    },
    [byId],
  );

  const toggleKind = React.useCallback((kind: KnowledgeMapEdgeKind) => {
    setShown((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const onUnsupported = React.useCallback(() => setUnsupported(true), []);
  const onSelect = React.useCallback((id: string | null) => setSelected(id), []);
  const onHover = React.useCallback(() => undefined, []);

  // Escape lets go of the selection or the tour, the way it closes a dialog.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setSelected(null);
      setTour(null);
      setScreensaver(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const bounds = React.useMemo(
    () =>
      timelineBounds(
        query.data?.nodes ?? [],
        query.data === undefined ? 0 : Date.parse(query.data.generatedAt),
      ),
    [query.data],
  );

  if (unsupported) {
    return (
      <div className="flex flex-1 items-center justify-center bg-map-space p-4">
        <EmptyState
          icon={MonitorXIcon}
          title={t('noWebglTitle')}
          description={t('noWebglDescription')}
        />
      </div>
    );
  }

  const selectedNode = selected === null ? undefined : byId.get(selected);
  const lineCount = (query.data?.edges ?? []).filter((edge) => shown.has(edge.kind)).length;

  return (
    <div
      ref={roomRef}
      className="relative flex-1 overflow-hidden bg-map-space"
      data-testid="knowledge-map"
    >
      <MapCanvas
        label={t('canvasLabel')}
        reducedMotion={reducedMotion}
        onReady={setEngine}
        onUnsupported={onUnsupported}
        onSelect={onSelect}
        onHover={onHover}
      />

      {query.isPending ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <LoadingState label={t('loading')} />
        </div>
      ) : null}
      {query.isError ? (
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <ErrorState title={t('errorTitle')} onRetry={() => void query.refetch()} />
        </div>
      ) : null}
      {query.data !== undefined && query.data.nodes.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <EmptyState
            icon={NetworkIcon}
            title={t('emptyTitle')}
            description={t('emptyDescription')}
          />
        </div>
      ) : null}

      {screensaver ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={stopScreensaver}
          className="absolute top-3 right-3 opacity-40 transition-opacity hover:opacity-100 focus-visible:opacity-100"
          data-testid="map-screensaver-exit"
        >
          {t('screensaverExit')}
        </Button>
      ) : null}

      {query.data !== undefined && query.data.nodes.length > 0 && !screensaver ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between gap-3 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-2">
              <MapHeader
                pages={query.data.nodes.length}
                lines={lineCount}
                semantic={query.data.semantic}
                onFit={() => engine?.zoomToFit()}
                appearanceOpen={appearanceOpen}
                onAppearance={() => setAppearanceOpen((open) => !open)}
                onScreensaver={startScreensaver}
              />
              {appearanceOpen ? (
                <MapAppearancePanel state={appearance} onClose={() => setAppearanceOpen(false)} />
              ) : null}
            </div>
            <div className="flex w-full max-w-sm flex-col gap-2">
              <MapAsk
                workspaceId={workspaceId}
                tour={tour}
                titleOf={titleOf}
                onResults={onResults}
                onAdvance={() =>
                  setTour((current) =>
                    current === null
                      ? null
                      : {
                          ...current,
                          index: Math.min(current.index + 1, current.stops.length - 1),
                        },
                  )
                }
                onStop={() => setTour(null)}
              />
              {selectedNode !== undefined ? (
                <MapNodeCard
                  workspaceId={workspaceId}
                  node={selectedNode}
                  onClose={() => setSelected(null)}
                />
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="hidden sm:block">
              <MapLegend
                shown={shown}
                onToggleKind={toggleKind}
                calm={calm}
                onCalmChange={setCalm}
                follow={follow}
                onFollowChange={setFollow}
              />
            </div>
            <div className="flex min-w-0 flex-1 justify-center">
              <MapTimeline
                bounds={bounds}
                moment={moment}
                onMomentChange={setMoment}
                reducedMotion={reducedMotion}
              />
            </div>
            <div className="hidden lg:block">
              <MapActivityFeed feed={feed} titleOf={titleOf} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
