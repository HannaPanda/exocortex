'use client';

import * as React from 'react';

import { type MapGraph, type PulseKind } from './map-model';
import {
  neighbourhoodOf,
  newWalker,
  nextDelay,
  stepWalker,
  type Walker,
  WALKER_STYLES,
} from './map-screensaver';

/** How often the walkers are asked whether it is their turn. */
const TICK_MS = 150;
/** Above this many pages a second researcher joins, so a big room is not quiet. */
const CROWDED = 120;

/**
 * Lets the screensaver's walkers loose on the map while `active` (issue #189).
 *
 * Only light: each step goes to `onPulse` exactly as a run's tool call would,
 * and nothing is sent to the server, written to the live feed or remembered.
 * The walkers keep their place when the map is refetched underneath them, and
 * start somewhere new when their page is gone.
 */
export function useMapScreensaver({
  active,
  graph,
  onPulse,
}: {
  active: boolean;
  graph: MapGraph | null;
  onPulse: (documentId: string, kind: PulseKind) => void;
}): void {
  const around = React.useMemo(() => (graph === null ? null : neighbourhoodOf(graph)), [graph]);
  const latest = React.useRef({ around, onPulse });
  React.useEffect(() => {
    latest.current = { around, onPulse };
  }, [around, onPulse]);

  React.useEffect(() => {
    if (!active) return;
    const crowded = (latest.current.around?.ids.length ?? 0) > CROWDED;
    const styles = crowded ? [...WALKER_STYLES, 'researcher' as const] : WALKER_STYLES;
    const start = performance.now();
    // Staggered, so the first second is not five lights at once.
    let walkers: { walker: Walker; due: number }[] = styles.map((style, index) => ({
      walker: newWalker(style),
      due: start + index * 400,
    }));
    const timer = setInterval(() => {
      const { around: current, onPulse: pulse } = latest.current;
      if (current === null) return;
      const now = performance.now();
      walkers = walkers.map((entry) => {
        if (now < entry.due) return entry;
        const step = stepWalker(entry.walker, current, Math.random);
        if (step === null) return { ...entry, due: now + 1_000 };
        pulse(step.visit.nodeId, step.visit.kind);
        return { walker: step.walker, due: now + nextDelay(entry.walker.style, Math.random) };
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
}
