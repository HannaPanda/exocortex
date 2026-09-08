'use client';

import { HocuspocusProvider } from '@hocuspocus/provider';
import * as React from 'react';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';

import {
  type DocumentSessionState,
  presenceColor,
  type PresenceUser,
  useDocumentSession,
} from '@/components/shell/document-session';
import { fetchCollaborationTicket } from '@/lib/api/queries';
import { type ConnectionDetailValue, logConnection } from '@/lib/connection-log';
import { onWakeSignals, type WakeReason } from '@/lib/wake-signals';

/**
 * How long a burst of typing has to be quiet before it counts as settled.
 * Yjs sends every update immediately; this only debounces the *display* of that
 * fact, so the indicator does not strobe while the user is writing.
 */
const SETTLE_DELAY_MS = 700;

/**
 * How long the connection may stay unusable before it is built again from a
 * fresh ticket.
 *
 * The provider reconnects on its own and never gives up, but that only covers
 * a socket that was open once and then closed: `onOpen` is what clears its
 * retry canceller. A handshake refused outright never reaches `onOpen`, so the
 * retry loop is the only thing left holding the connection, and when it ends
 * the tab is simply dead. On 2026-09-08 a deploy restarted the collaboration
 * unit under an open page, nginx answered the upgrade with 502, and the tab sat
 * disconnected for eight minutes without one further attempt reaching the
 * server. Only F5 brought it back.
 *
 * Rebuilding is cheap and lossless: the Yjs document merges rather than
 * replaces, and the offline copy carries whatever was typed in the meantime.
 */
const REVIVE_DELAY_MS = 20_000;

/** The revive delay doubles per consecutive failure, up to this ceiling. */
const REVIVE_MAX_DELAY_MS = 120_000;

/**
 * Writes one collaboration event to the shared connection log.
 *
 * At module scope rather than inside the effect so that adding a line costs the
 * effect one call and not one closure, and so the channel name is written down
 * exactly once.
 */
const record = (event: string, detail?: Record<string, ConnectionDetailValue>): void =>
  logConnection('collab', event, detail);

/**
 * How many providers currently exist in this tab.
 *
 * One page can only ever need one. A count that climbs is the signature of a
 * connection that is being rebuilt faster than it is being torn down, and every
 * surviving provider holds a socket the browser counts against its per-host
 * limit -- so a number above one here is the fault, not a symptom of it. Logged
 * on both sides of the lifecycle so a dump shows the climb.
 */
let providerCount = 0;

/**
 * The `token` callback Hocuspocus calls on every socket open.
 *
 * A ticket lives about a minute (`COLLABORATION_TICKET_TTL_SECONDS`), and the
 * provider reconnects on its own for as long as the page is open. Handing over
 * the ticket as a *string* meant every reconnect replayed the one minted at
 * mount: once a single outage outlasted the TTL -- a waking laptop, a wifi blip,
 * a deploy restarting the collaboration unit -- every attempt from then on was
 * rejected as `expired`, every 32 seconds, for ever, and only F5 recovered.
 * Asking again per open means each attempt carries a ticket that is valid.
 *
 * The first call reuses `first` rather than asking for a second ticket for the
 * very same connection.
 */
function ticketSource(documentId: string, first: string): () => Promise<string> {
  let pending: string | null = first;
  return async () => {
    const reusable = pending;
    pending = null;
    if (reusable !== null) {
      record('token.reused');
      return reusable;
    }
    // A rejection here never surfaces anywhere: Hocuspocus awaits this function
    // before it opens the socket, so a failure means no socket and no event --
    // exactly the silence the connection log exists to break.
    record('token.request');
    try {
      const fresh = await fetchCollaborationTicket(documentId);
      record('token.granted');
      return fresh.ticket;
    } catch (cause) {
      record('token.failed', { message: cause instanceof Error ? cause.message : String(cause) });
      throw cause;
    }
  };
}

/** How the shell is told about a change; the provider's `update`, narrowed. */
type PublishSession = (patch: Partial<DocumentSessionState>) => void;

/**
 * Mirrors the awareness states into the shell's presence list.
 *
 * At module scope because presence has nothing to do with the connection's
 * lifecycle: it needs the provider and the current user and nothing else, and
 * it dies with the provider rather than with a timer of its own.
 */
function attachPresence(
  provider: HocuspocusProvider,
  currentUser: { id: string; name: string },
  publish: PublishSession,
): void {
  provider.awareness?.setLocalStateField('user', {
    name: currentUser.name,
    color: presenceColor(currentUser.id),
  });

  const readPresence = (): void => {
    const states = provider.awareness?.getStates();
    if (states === undefined) return;
    const users: PresenceUser[] = [];
    for (const [clientId, state] of states) {
      const user = (state as { user?: { name?: string; color?: string } }).user;
      if (user === undefined) continue;
      users.push({
        clientId,
        name: user.name ?? 'Unbekannt',
        color: user.color ?? presenceColor(String(clientId)),
        self: clientId === provider.awareness?.clientID,
      });
    }
    publish({ presence: users });
  };

  provider.awareness?.on('change', readPresence);
  readPresence();
}

/**
 * Drives the offline flag and the save indicator from local edits.
 *
 * The shell is told twice per typing burst (once when it starts, once when it
 * settles) rather than on every keystroke, which would re-render the whole
 * application shell while the user types. Returns the timer's canceller.
 */
function attachSaveIndicator(
  ydoc: Y.Doc,
  provider: HocuspocusProvider,
  live: () => boolean,
  publish: PublishSession,
): () => void {
  let settle: ReturnType<typeof setTimeout> | undefined;
  let settling = false;
  ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
    if (origin === provider) return;
    if (!live()) {
      publish({ pendingSync: true });
      return;
    }
    if (!settling) {
      settling = true;
      publish({ saveState: 'saving' });
    }
    clearTimeout(settle);
    settle = setTimeout(() => {
      settling = false;
      publish({ saveState: 'saved', savedAt: Date.now() });
    }, SETTLE_DELAY_MS);
  });
  return () => clearTimeout(settle);
}

/** The three objects one open document is made of. */
export interface Connection {
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  persistence: IndexeddbPersistence;
}

export interface CollaborationConnectionOptions {
  documentId: string;
  /** A label only; a rename must never tear the connection down. */
  documentTitle: string;
  currentUser: { id: string; name: string };
}

export interface CollaborationConnectionState {
  /** `null` until the provider exists; the editor is built from it. */
  connection: Connection | null;
  /** German message for the error state, or `null`. */
  error: string | null;
  /** `true` once the first server handshake has completed. */
  synced: boolean;
  /** Builds the connection again from the ticket up. */
  retry: () => void;
}

/**
 * Owns the live document: the ticket, the Yjs document, its offline copy, the
 * Hocuspocus provider, presence, and everything the application shell is told
 * about all of that.
 *
 * Split out of `collaborative-editor.tsx` so the editor component is about the
 * editor. Nothing here renders; the component decides what a missing connection
 * or an error looks like.
 */
export function useCollaborationConnection({
  documentId,
  documentTitle,
  currentUser,
}: CollaborationConnectionOptions): CollaborationConnectionState {
  const { update } = useDocumentSession();
  // Unpacked so the effect depends on the two values rather than on the object:
  // callers rebuild `currentUser` on every render, and depending on the object
  // would tear the live connection down and back up on each one.
  const { id: userId, name: userName } = currentUser;
  const [connection, setConnection] = React.useState<Connection | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [synced, setSynced] = React.useState(false);
  /**
   * Bumped by the error state's retry button. The first ticket request is the
   * one thing here with no retry of its own — the provider retries the socket
   * for ever, but a failed `fetchCollaborationTicket` used to end the attempt
   * and leave a dead panel behind until the whole page was reloaded.
   */
  const [attempt, setAttempt] = React.useState(0);
  const retry = React.useCallback(() => setAttempt((previous) => previous + 1), []);
  /**
   * Consecutive revivals, for the backoff below. A ref rather than state: a
   * revival re-runs the effect, so the count has to survive that, and it must
   * never cause a render of its own.
   */
  const reviveCount = React.useRef(0);
  /** The document the backoff above belongs to; see the effect. */
  const reviveDocument = React.useRef(documentId);

  /**
   * The title is a label, not part of the connection.
   *
   * It used to be a dependency of the effect below, which meant that renaming a
   * page tore the live connection down and built a new one: a fresh ticket, a
   * fresh `Y.Doc`, a fresh IndexedDB handle, and in between a spinner where the
   * editor had been. Anything typed in that gap went into a document that was
   * about to be thrown away. Reading it through a ref keeps the current value
   * available to `connect()` without making a rename a reconnect.
   */
  const documentTitleRef = React.useRef(documentTitle);

  // The session label follows the title on its own, with nothing torn down.
  // Declared before the connection effect so that on the first mount the ref is
  // already current by the time `connect()` reads it.
  React.useEffect(() => {
    documentTitleRef.current = documentTitle;
    update({ documentTitle });
  }, [documentTitle, update]);

  // Connection setup. Re-runs only when the document or the user changes.
  React.useEffect(() => {
    // Opening a different document is not a failed attempt at this one, so it
    // starts over with the short delay rather than inheriting a grown backoff.
    if (reviveDocument.current !== documentId) {
      reviveDocument.current = documentId;
      reviveCount.current = 0;
    }

    let disposed = false;
    let active: Connection | null = null;
    // Cancels the save indicator's debounce; set once `connect()` has run.
    let stopSaveIndicator: (() => void) | undefined;
    // Watchdog for a connection that never came back; cleared on unmount.
    let revive: ReturnType<typeof setTimeout> | undefined;

    /**
     * What a wake signal should do, once there is a connection to do it to.
     *
     * The listeners are attached here, in the effect body, and not inside
     * `connect()` where the handler is written. That distinction was a real
     * defect for a few hours on 2026-09-08: `connect()` is async, so a `retry()`
     * arriving while it was still awaiting its ticket ran this cleanup *first*,
     * found nothing attached yet, and `connect()` then attached listeners that
     * nothing would ever remove. Each orphan called `retry()` on the next tab
     * switch, which mounted another effect, which left another orphan. Providers
     * doubled with every visit to the tab until the browser refused to open any
     * further socket -- a refusal that never reaches the server, which is why
     * nginx saw nothing at all while the tab was dead.
     *
     * Attaching them to the effect's own lifetime makes that impossible: the
     * cleanup below always detaches exactly what the effect attached, however
     * far `connect()` got.
     */
    let onWake: ((reason: WakeReason) => void) | null = null;
    const detachWake = onWakeSignals((reason) => onWake?.(reason));

    const connect = async (): Promise<void> => {
      setError(null);
      setSynced(false);
      update({
        documentId,
        documentTitle: documentTitleRef.current,
        collaboration: 'connecting',
        presence: [],
        saveState: 'idle',
        savedAt: null,
      });

      let ticket: Awaited<ReturnType<typeof fetchCollaborationTicket>>;
      record('ticket.request', { documentId, attempt });
      try {
        ticket = await fetchCollaborationTicket(documentId);
      } catch (cause) {
        record('ticket.failed', {
          message: cause instanceof Error ? cause.message : String(cause),
        });
        if (!disposed) setError('Die Live-Bearbeitung konnte nicht gestartet werden.');
        return;
      }
      record('ticket.granted', {
        url: ticket.collaborationUrl,
        name: ticket.documentName,
        access: ticket.access,
      });
      if (disposed) {
        record('ticket.discarded', { reason: 'disposed' });
        return;
      }

      const ydoc = new Y.Doc();
      // Offline persistence: the local copy is available before the socket opens.
      const persistence = new IndexeddbPersistence(`exocortex:${documentId}`, ydoc);

      const nextTicket = ticketSource(documentId, ticket.ticket);

      /**
       * An open socket is not a usable document. The two used to be reported as
       * one, so a connection whose ticket was refused showed "Verbunden" in the
       * header while nothing was being synchronized at all. Both halves are
       * tracked, and only both together count as live — which is also what
       * decides whether a local edit is still pending.
       */
      let socketStatus: 'connected' | 'connecting' | 'disconnected' = 'connecting';
      let authenticated = false;
      const live = (): boolean => socketStatus === 'connected' && authenticated;
      /**
       * Rebuilds the connection once it has been unusable for too long.
       *
       * Armed on every status change: a live connection disarms it and clears
       * the backoff, anything else gives the provider a window to recover on
       * its own before the connection is thrown away and built again.
       */
      const armRevive = (): void => {
        clearTimeout(revive);
        if (live()) {
          reviveCount.current = 0;
          return;
        }
        const delay = Math.min(REVIVE_DELAY_MS * 2 ** reviveCount.current, REVIVE_MAX_DELAY_MS);
        record('revive.armed', { delayMs: delay, socket: socketStatus, authenticated });
        revive = setTimeout(() => {
          if (disposed) return;
          reviveCount.current += 1;
          record('revive.fired', { count: reviveCount.current });
          retry();
        }, delay);
      };

      const publishStatus = (): void => {
        update({
          collaboration: live()
            ? ticket.access === 'read'
              ? 'read-only'
              : 'connected'
            : socketStatus === 'disconnected'
              ? 'disconnected'
              : 'connecting',
        });
        armRevive();
      };

      providerCount += 1;
      record('provider.create', {
        url: ticket.collaborationUrl,
        name: ticket.documentName,
        live: providerCount,
      });
      const provider = new HocuspocusProvider({
        url: ticket.collaborationUrl,
        name: ticket.documentName,
        document: ydoc,
        token: nextTicket,
        onOpen: () => record('socket.open'),
        onClose: ({ event }) => record('socket.close', { code: event.code, reason: event.reason }),
        onStatus: ({ status }) => {
          record('status', { status });
          socketStatus =
            status === 'connected'
              ? 'connected'
              : status === 'connecting'
                ? 'connecting'
                : 'disconnected';
          // Every new socket re-authenticates; until it has, the document is not
          // usable even though the socket may already be open.
          if (socketStatus !== 'connected') authenticated = false;
          publishStatus();
        },
        onAuthenticated: () => {
          record('authenticated');
          authenticated = true;
          publishStatus();
        },
        onAuthenticationFailed: () => {
          record('authentication.failed');
          authenticated = false;
          publishStatus();
        },
        onSynced: () => {
          record('synced');
          setSynced(true);
          update({ pendingSync: false });
        },
        onDisconnect: () => {
          record('disconnected');
          socketStatus = 'disconnected';
          authenticated = false;
          publishStatus();
        },
      });

      stopSaveIndicator = attachSaveIndicator(ydoc, provider, live, update);
      attachPresence(provider, { id: userId, name: userName }, update);

      // A provider that never emits a status change would otherwise never arm
      // the watchdog at all.
      armRevive();

      /**
       * Coming back to the tab is a fresh signal, not another failure.
       *
       * The backoff above grows to two minutes, which is the right pace for a
       * page nobody is looking at but the wrong one for the moment someone
       * returns to it and finds the header saying "getrennt". A connection that
       * is merely `connecting` is left alone: tearing down an attempt that is
       * still in flight would replace one wait with another.
       */
      onWake = (reason: WakeReason): void => {
        record('wake', { reason, socket: socketStatus, authenticated, disposed });
        if (disposed || live() || socketStatus === 'connecting') return;
        clearTimeout(revive);
        reviveCount.current = 0;
        retry();
      };

      active = { provider, ydoc, persistence };
      if (disposed) {
        providerCount -= 1;
        record('provider.discarded', { reason: 'disposed', live: providerCount });
        provider.destroy();
        void persistence.destroy();
        ydoc.destroy();
        return;
      }
      setConnection(active);
    };

    void connect();

    return () => {
      disposed = true;
      record('teardown');
      onWake = null;
      stopSaveIndicator?.();
      clearTimeout(revive);
      detachWake();
      if (active !== null) {
        providerCount -= 1;
        record('provider.destroy', { live: providerCount });
        active.provider.destroy();
        void active.persistence.destroy();
        active.ydoc.destroy();
      }
      setConnection(null);
      update({
        documentId: null,
        presence: [],
        collaboration: 'connecting',
        saveState: 'idle',
        savedAt: null,
      });
    };
    // `update` is stable (useCallback in the provider). `documentTitle` is
    // deliberately absent; see the ref above for why. `attempt` is here so the
    // retry button rebuilds the connection from the ticket up.
  }, [attempt, documentId, retry, update, userId, userName]);

  return { connection, error, synced, retry };
}
