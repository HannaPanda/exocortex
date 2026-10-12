'use client';

import * as React from 'react';

import {
  DEFAULT_KNOWLEDGE_MAP_APPEARANCE,
  type KnowledgeMapAppearance,
  type KnowledgeMapAppearancePatch,
  mergeKnowledgeMapAppearance,
} from '@exocortex/contracts';

import {
  useKnowledgeMapAppearance,
  useSetKnowledgeMapAppearance,
} from '@/lib/api/knowledge-map-queries';

/** How long a slider has to rest before the look is saved. */
const SAVE_AFTER_MS = 600;

export interface MapAppearanceState {
  appearance: KnowledgeMapAppearance;
  isDefault: boolean;
  saving: boolean;
  change: (patch: KnowledgeMapAppearancePatch) => void;
  reset: () => void;
}

/**
 * The person's look of the map (issue #189), as a live draft over what is
 * stored: a change shows on the canvas at once and is saved once the hand
 * rests, so dragging a slider sends one request rather than sixty.
 */
export function useMapAppearance(): MapAppearanceState {
  const stored = useKnowledgeMapAppearance();
  const save = useSetKnowledgeMapAppearance();
  const [draft, setDraft] = React.useState<KnowledgeMapAppearance | null>(null);
  const [pending, setPending] = React.useState(false);

  const appearance = draft ?? stored.data?.appearance ?? DEFAULT_KNOWLEDGE_MAP_APPEARANCE;
  const latest = React.useRef(appearance);
  React.useEffect(() => {
    latest.current = appearance;
  }, [appearance]);

  const { mutate } = save;
  React.useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => {
      // The whole look is a valid patch, and the simplest one to get right.
      mutate(latest.current, { onSettled: () => setPending(false) });
    }, SAVE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [pending, draft, mutate]);

  const change = React.useCallback((patch: KnowledgeMapAppearancePatch) => {
    setDraft((current) => mergeKnowledgeMapAppearance(current ?? latest.current, patch));
    setPending(true);
  }, []);

  const reset = React.useCallback(() => {
    setPending(false);
    mutate('reset', { onSuccess: () => setDraft(null) });
  }, [mutate]);

  return {
    appearance,
    isDefault: draft === null && (stored.data?.isDefault ?? true),
    saving: pending || save.isPending,
    change,
    reset,
  };
}
