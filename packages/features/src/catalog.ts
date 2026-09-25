import { FEATURE_AREAS, type FeatureArea } from '@exocortex/contracts';

import { type RegisteredFeature } from './feature.js';
import { AI_FEATURES } from './features/ai.js';
import { COLLABORATION_FEATURES } from './features/collaboration.js';
import { DATA_FEATURES } from './features/data.js';
import { PAGE_FEATURES } from './features/pages.js';
import { PLATFORM_FEATURES } from './features/platform.js';
import { PUBLISHING_FEATURES } from './features/publishing.js';

const areaOrder = new Map<FeatureArea, number>(FEATURE_AREAS.map((area, index) => [area, index]));

/**
 * Every feature this deployment has, grouped by area and, inside an area,
 * newest first.
 *
 * Newest first inside a group rather than alphabetically, because the reason
 * somebody opens this list is usually "what is here that I have not seen".
 * The help page's "new for you" filter answers that precisely; this ordering
 * answers it for the reader who is only browsing.
 *
 * Ties on the same day are broken by id here, which only keeps the order
 * stable. The API breaks them again by the title it rendered, collated in the
 * reader's language, because the title is not known until the locale is.
 */
export const FEATURES: readonly RegisteredFeature[] = Object.freeze(
  [
    ...PAGE_FEATURES,
    ...DATA_FEATURES,
    ...COLLABORATION_FEATURES,
    ...AI_FEATURES,
    ...PUBLISHING_FEATURES,
    ...PLATFORM_FEATURES,
  ].sort((a, b) => {
    const byArea = (areaOrder.get(a.area) ?? 0) - (areaOrder.get(b.area) ?? 0);
    if (byArea !== 0) return byArea;
    if (a.since !== b.since) return a.since < b.since ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }),
);

export function findFeature(id: string): RegisteredFeature | null {
  return FEATURES.find((feature) => feature.id === id) ?? null;
}

/** The newest `since` in the catalogue. What "mark as read" sets the marker to. */
export function latestFeatureDate(): string {
  return FEATURES.reduce(
    (latest, feature) => (feature.since > latest ? feature.since : latest),
    '',
  );
}
