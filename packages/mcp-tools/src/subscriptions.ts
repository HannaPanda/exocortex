import { type ApplicationEvent } from '@exocortex/contracts';

import { pageResourceUri, parseResourceUri, workspaceTreeResourceUri } from './resources.js';

/**
 * `resources/subscribe`, the third part of the protocol's resource half
 * (issue #48, ADR-035).
 *
 * A subscription is a promise: the client attached a page and wants to hear
 * that it changed without asking again. Two things make that promise hard, and
 * both are solved outside this file — a server-initiated channel, which each
 * transport opens its own way, and the authorization behind every message,
 * which is re-checked per event where the events are. What is left here is the
 * part both transports share: which URIs a connection has asked about, and
 * which URIs one change touches.
 */

/**
 * How many resources one connection may subscribe to.
 *
 * A cap rather than no cap because the set lives for as long as the connection
 * does, and a client that subscribes in a loop would otherwise grow it without
 * end. Generous: a person attaching pages by hand will not reach it, and a
 * client that does is doing something this feature is not for.
 */
export const MAX_RESOURCE_SUBSCRIPTIONS = 200;

/** Why a `resources/subscribe` was refused. */
export type SubscribeRejection = 'unknown-uri' | 'too-many';

/**
 * The URIs one connection listens to.
 *
 * Deliberately a dumb set. It does *not* check whether the caller may read the
 * page behind a URI, and that is not an omission: a subscription that failed
 * for a page somebody else owns, while succeeding for a page that exists and
 * is readable, would answer the one question `resources/read` already refuses
 * to answer — whether an id exists at all. So a well-formed URI is always
 * accepted, and a caller who may not read it simply never hears anything.
 */
export class ResourceSubscriptions {
  private readonly uris = new Set<string>();

  /**
   * @param onSubscribed Run after the first URI is accepted, and after every
   * one after it. The stdio transport uses it to open its change feed only
   * once something is actually being watched; a transport whose channel is
   * already open passes nothing.
   */
  constructor(private readonly onSubscribed?: () => void) {}

  get size(): number {
    return this.uris.size;
  }

  /** `null` on success, otherwise why it was refused. */
  subscribe(uri: string): SubscribeRejection | null {
    if (parseResourceUri(uri) === null) return 'unknown-uri';
    if (!this.uris.has(uri) && this.uris.size >= MAX_RESOURCE_SUBSCRIPTIONS) return 'too-many';
    this.uris.add(uri);
    this.onSubscribed?.();
    return null;
  }

  /**
   * Unsubscribing from something that was never subscribed is a success, not
   * an error: the client wanted to stop hearing about it, and it will not.
   */
  unsubscribe(uri: string): void {
    this.uris.delete(uri);
  }

  has(uri: string): boolean {
    return this.uris.has(uri);
  }

  /** The subset of `uris` this connection asked about, in the given order. */
  matching(uris: readonly string[]): string[] {
    return uris.filter((uri) => this.uris.has(uri));
  }

  list(): string[] {
    return [...this.uris];
  }

  /**
   * Forgets everything. Used when a connection's authority changed underneath
   * it (ADR-029): the subscriptions are dropped with the channel rather than
   * filtered, so whatever comes back has been authorized from scratch.
   */
  clear(): void {
    this.uris.clear();
  }
}

/**
 * Which resources one application event changed.
 *
 * Three kinds of URI can be touched by a single event, and missing any of them
 * makes a subscription quietly wrong rather than loudly broken:
 *
 *  * the page itself, when its text, title or place changed,
 *  * its parent, because a page resource carries its direct children, so a new
 *    or moved child changes a page nobody touched,
 *  * the workspace tree, for anything that changes the shape of the hierarchy.
 *
 * Events that are not about documents produce an empty list, which is how the
 * feed stays quiet while a build runs or a model streams.
 */
export function resourceUrisForEvent(event: ApplicationEvent): string[] {
  const uris = new Set<string>();
  const tree = (): void => {
    uris.add(workspaceTreeResourceUri(event.workspaceId));
  };

  switch (event.type) {
    case 'document.materialized':
    case 'document.content.replaced':
    case 'document.overview.updated':
      // Body only. The page changed; where it sits did not.
      uris.add(pageResourceUri(event.payload.documentId));
      break;

    case 'document.updated':
      uris.add(pageResourceUri(event.payload.document.id));
      // A rename is visible in the parent's child list and in the tree.
      tree();
      if (event.payload.document.parentId !== null) {
        uris.add(pageResourceUri(event.payload.document.parentId));
      }
      break;

    case 'document.created':
    case 'document.archived':
    case 'document.restored':
      uris.add(pageResourceUri(event.payload.document.id));
      tree();
      if (event.payload.document.parentId !== null) {
        uris.add(pageResourceUri(event.payload.document.parentId));
      }
      break;

    case 'document.moved':
      uris.add(pageResourceUri(event.payload.document.id));
      tree();
      // Both ends of the move: the list it left and the list it joined.
      if (event.payload.previousParentId !== null) {
        uris.add(pageResourceUri(event.payload.previousParentId));
      }
      if (event.payload.document.parentId !== null) {
        uris.add(pageResourceUri(event.payload.document.parentId));
      }
      break;

    case 'document.deleted':
      // Every id, not just the one that was asked about: deleting a page
      // deletes the branch under it, and a subscriber to a page three levels
      // down is exactly who needs to know.
      for (const documentId of event.payload.documentIds) {
        uris.add(pageResourceUri(documentId));
      }
      tree();
      break;

    default:
      break;
  }

  return [...uris];
}

/** The JSON-RPC notification a transport writes when a subscribed URI changed. */
export function resourceUpdatedNotification(uri: string): {
  jsonrpc: '2.0';
  method: 'notifications/resources/updated';
  params: { uri: string };
} {
  return { jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } };
}
