'use client';

import * as React from 'react';

import { readMapPalette } from './map-colors';
import { type MapEngine } from './map-engine';

/** Whether this browser can open a WebGL context at all. */
function canDrawWebgl(): boolean {
  try {
    const probe = document.createElement('canvas');
    return probe.getContext('webgl2') !== null || probe.getContext('webgl') !== null;
  } catch {
    return false;
  }
}

export interface MapCanvasProps {
  label: string;
  reducedMotion: boolean;
  onReady: (engine: MapEngine | null) => void;
  onUnsupported: () => void;
  onSelect: (nodeId: string | null) => void;
  onHover: (nodeId: string | null) => void;
}

/**
 * The element the engine draws into. The engine is loaded on the client only
 * and only here: `three` and the force simulation are half a megabyte that no
 * other screen needs, and they touch `window` while they load.
 */
export function MapCanvas({
  label,
  reducedMotion,
  onReady,
  onUnsupported,
  onSelect,
  onHover,
}: MapCanvasProps) {
  const host = React.useRef<HTMLDivElement>(null);
  const callbacks = React.useRef({ onReady, onUnsupported, onSelect, onHover });
  React.useEffect(() => {
    callbacks.current = { onReady, onUnsupported, onSelect, onHover };
  }, [onReady, onUnsupported, onSelect, onHover]);

  React.useEffect(() => {
    const element = host.current;
    if (element === null) return;
    if (!canDrawWebgl()) {
      callbacks.current.onUnsupported();
      return;
    }
    let engine: MapEngine | null = null;
    let cancelled = false;
    void import('./map-engine').then(({ MapEngine: Engine }) => {
      if (cancelled) return;
      engine = new Engine(element, readMapPalette(), {
        reducedMotion,
        onSelect: (id) => callbacks.current.onSelect(id),
        onHover: (id) => callbacks.current.onHover(id),
      });
      callbacks.current.onReady(engine);
    });

    const resize = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      engine?.setSize(entry.contentRect.width, entry.contentRect.height);
    });
    resize.observe(element);

    return () => {
      cancelled = true;
      resize.disconnect();
      callbacks.current.onReady(null);
      engine?.dispose();
    };
  }, [reducedMotion]);

  return (
    <div
      ref={host}
      role="img"
      aria-label={label}
      className="absolute inset-0 bg-map-space"
      data-testid="knowledge-map-canvas"
    />
  );
}
