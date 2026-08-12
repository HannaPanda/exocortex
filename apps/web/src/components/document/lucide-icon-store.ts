'use client';

import * as React from 'react';

/**
 * One element of a Lucide icon's drawing: a tag name and its attributes.
 *
 * Spelled out rather than imported as Lucide's `IconNode`, because the generated
 * data module has to name this type and must not drag the icon library into its
 * own chunk to do it. The two are checked against each other where `Icon` is
 * rendered.
 */
export type LucideIconNode = [
  tag: 'circle' | 'ellipse' | 'g' | 'line' | 'path' | 'polygon' | 'polyline' | 'rect',
  attributes: Record<string, string>,
][];

export interface LucideIconData {
  /** Every canonical icon name to the shapes that draw it. */
  readonly nodes: Readonly<Record<string, LucideIconNode>>;
  /**
   * Lucide's own alternative spellings, `"add" -> "plus"`. Only the search reads
   * them; a stored icon always uses the canonical name.
   */
  readonly aliases: Readonly<Record<string, string>>;
}

/**
 * The half-megabyte of Lucide path data, loaded once and shared.
 *
 * Why it is not simply imported: `DocumentIcon` renders in the page tree, the
 * breadcrumb and every search result, so anything it imports statically is in the
 * first bundle the browser downloads. The curated icons therefore stay a static
 * component map in `document-icon.tsx`, and this module carries the other 1,700 —
 * fetched when the picker opens, or when a page turns out to wear one of them.
 *
 * A module-level cache rather than React state: the data is immutable, identical
 * for every component, and outlives any of them.
 */
let data: LucideIconData | null = null;
let request: Promise<LucideIconData> | null = null;
const listeners = new Set<() => void>();

export function loadLucideIconData(): Promise<LucideIconData> {
  if (data !== null) return Promise.resolve(data);
  request ??= import('./lucide-icon-nodes.generated').then((module) => {
    data = module.LUCIDE_ICON_DATA;
    for (const listener of listeners) listener();
    return module.LUCIDE_ICON_DATA;
  });
  return request;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): LucideIconData | null {
  return data;
}

/** Never available while rendering on the server, and never needed there. */
function getServerSnapshot(): null {
  return null;
}

/**
 * The icon data, requesting it on first use.
 *
 * Returns `null` until it has arrived. Callers draw nothing in that gap rather
 * than a placeholder symbol: the gap is one chunk long, and a wrong icon that
 * corrects itself is more distracting than an empty box of the right size.
 */
export function useLucideIconData(): LucideIconData | null {
  const value = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  React.useEffect(() => {
    void loadLucideIconData();
  }, []);

  return value;
}
