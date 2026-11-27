import * as Y from 'yjs';

import { calloutAttributes } from './callout';
import { needsCalloutMigration } from './schema-v6';
import { YJS_DOCUMENT_FIELD,yjsStateToDocument } from './yjs';

/*
 * Schema version 6 (issue #306) applied to the canonical Yjs state itself.
 * Kept apart from `schema-v6.ts` because the registry imports that file and
 * this one needs the Yjs bridge, which imports the registry.
 */

/** Every callout element below `parent`, nested ones included. */
function collectCallouts(parent: Y.XmlFragment | Y.XmlElement, into: Y.XmlElement[]): void {
  for (const child of parent.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === 'callout') into.push(child);
    collectCallouts(child, into);
  }
}

/**
 * Migrates the callouts of a live Yjs document in place and returns how many
 * changed. Idempotent: a callout already carrying a symbol and no variant is
 * left alone, so a second run, or a run on a page somebody edited in the
 * meantime, writes nothing.
 *
 * Only attributes are set and removed, in one transaction: the callout keeps
 * its identity and its content, so an open editor sees the box change its
 * frame and nothing else.
 */
export function migrateCalloutsInYjsDoc(doc: Y.Doc, origin: unknown = null): number {
  const callouts: Y.XmlElement[] = [];
  collectCallouts(doc.getXmlFragment(YJS_DOCUMENT_FIELD), callouts);
  const pending = callouts.filter((element) => needsCalloutMigration(element.getAttributes()));
  if (pending.length === 0) return 0;

  doc.transact(() => {
    for (const element of pending) {
      const next = calloutAttributes(element.getAttributes());
      for (const name of ['emoji', 'title', 'color'] as const) {
        const value = next[name];
        // y-prosemirror stores no attribute for `null`; neither does this.
        if (typeof value === 'string') element.setAttribute(name, value);
        else if (element.getAttribute(name) !== undefined) element.removeAttribute(name);
      }
      if (element.getAttribute('variant') !== undefined) element.removeAttribute('variant');
    }
  }, origin);
  return pending.length;
}

export interface CalloutStateMigration {
  /** The migrated state, or `null` when nothing had to change. */
  yjsState: Uint8Array | null;
  migrated: number;
}

/** `migrateCalloutsInYjsDoc` for a stored binary state. */
export function migrateCalloutsInYjsState(state: Uint8Array): CalloutStateMigration {
  const doc = yjsStateToDocument(state);
  try {
    const migrated = migrateCalloutsInYjsDoc(doc);
    return { yjsState: migrated === 0 ? null : Y.encodeStateAsUpdate(doc), migrated };
  } finally {
    doc.destroy();
  }
}
