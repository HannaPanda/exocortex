import { type Connection, type Hocuspocus } from '@hocuspocus/server';

import { resolveCollaborationAccess, type WorkspaceAccessService } from '@exocortex/auth';
import { type AuthorizationRevocation } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';
import { RedisRevocationBus } from '@exocortex/queue';

import { type CollaborationContext } from './server';

/**
 * How often every open connection is re-authorized against the database.
 *
 * The revocation channel is the fast path; this sweep is what makes the
 * guarantee survive a dropped message or a process that was restarting when one
 * was published. Half a minute bounds how long a withdrawn permission can
 * outlive itself, and costs two queries per open connection per sweep.
 */
const DEFAULT_RECHECK_INTERVAL_MS = 30_000;

/**
 * Close code sent to a connection whose authorization changed.
 *
 * 4403 is Hocuspocus's own "Forbidden". The client reconnects by itself and
 * asks for a fresh collaboration ticket while doing so, so this is not a
 * punishment but the re-authorization path: whoever still has access is back
 * within a second with the rights they have *now*, and whoever does not is
 * refused at the handshake.
 */
const REVOKED_CLOSE_CODE = 4403;

export interface AuthorizationRevocations {
  /** Resolves once the Redis channel is being listened to. */
  ready: Promise<void>;
  /** Applies one revocation to the connections this process holds. */
  apply(revocation: AuthorizationRevocation): void;
  /** Re-authorizes every open connection against the database. */
  recheck(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateAuthorizationRevocationsOptions {
  hocuspocus: Hocuspocus<CollaborationContext>;
  access: WorkspaceAccessService;
  logger: Logger;
  redisUrl: string;
  recheckIntervalMs?: number;
}

/**
 * The context `onAuthenticate` attached, read back from a connection.
 *
 * Hocuspocus types `Connection#context` as the server's context parameter, but
 * the `Document#connections` map is not generic, so what comes back out of it
 * is untyped. This is the one place that narrows it, rather than casting at
 * every use (rule 7).
 */
function contextOf(connection: Connection): CollaborationContext | null {
  const context: unknown = connection.context;
  if (typeof context !== 'object' || context === null) return null;
  const candidate = context as Partial<CollaborationContext>;
  if (typeof candidate.userId !== 'string') return null;
  if (typeof candidate.workspaceId !== 'string') return null;
  if (typeof candidate.documentId !== 'string') return null;
  return candidate as CollaborationContext;
}

function* openConnections(
  hocuspocus: Hocuspocus<CollaborationContext>,
): Generator<{ connection: Connection; context: CollaborationContext }> {
  for (const document of hocuspocus.documents.values()) {
    for (const connection of document.connections.keys()) {
      const context = contextOf(connection);
      if (context === null) continue;
      yield { connection, context };
    }
  }
}

/**
 * Withdrawal of collaboration rights from connections that are already open
 * (issue #62).
 *
 * `onAuthenticate` decides once, at the handshake, and a document connection
 * then lives as long as the tab does. Without this, a member who was removed
 * from the workspace kept writing through the socket they already had, and a
 * demotion to a read-only role did not reach the connection that was authorized
 * as writable.
 *
 * Two steps per affected connection, in this order:
 *
 *  1. `readOnly = true`, which takes effect on the very next message. A close
 *     is a round trip; a message that is already in the socket's buffer would
 *     win that race, and it must not.
 *  2. close the underlying socket, so the client reconnects and is authorized
 *     from scratch. That is also what makes a *widened* permission take effect
 *     only through the front door: the connection is replaced, never patched.
 */
export function createAuthorizationRevocations(
  options: CreateAuthorizationRevocationsOptions,
): AuthorizationRevocations {
  const logger = options.logger.child({ component: 'collaboration-revocations' });
  const bus = new RedisRevocationBus({ redisUrl: options.redisUrl, logger: options.logger });
  let closed = false;

  const revoke = (
    entry: { connection: Connection; context: CollaborationContext },
    reason: string,
  ): void => {
    entry.connection.readOnly = true;
    logger.info('Revoking a collaboration connection', {
      documentId: entry.context.documentId,
      workspaceId: entry.context.workspaceId,
      userId: entry.context.userId,
      reason,
    });
    entry.connection.webSocket.close(REVOKED_CLOSE_CODE, 'authorization_revoked');
  };

  const apply = (revocation: AuthorizationRevocation): void => {
    for (const entry of openConnections(options.hocuspocus)) {
      if (entry.context.userId !== revocation.userId) continue;
      // A null workspace means the account itself: every connection it holds.
      if (revocation.workspaceId !== null && entry.context.workspaceId !== revocation.workspaceId) {
        continue;
      }
      revoke(entry, revocation.reason);
    }
  };

  const recheck = async (): Promise<void> => {
    const entries = [...openConnections(options.hocuspocus)];
    if (entries.length === 0) return;

    try {
      const disabled = await options.access.findDisabledUserIds([
        ...new Set(entries.map((entry) => entry.context.userId)),
      ]);

      for (const entry of entries) {
        if (disabled.has(entry.context.userId)) {
          revoke(entry, 'account_disabled');
          continue;
        }

        const context = await options.access.findDocumentContext(
          entry.context.documentId,
          entry.context.userId,
        );
        if (context === null) {
          revoke(entry, 'workspace_membership_removed');
          continue;
        }
        // A connection that has already lost its write right keeps its socket:
        // reading is still allowed, and dropping it would cost the tab its
        // unsynced offline edits for no gain.
        if (
          entry.context.access === 'write' &&
          resolveCollaborationAccess(context.role, context.document) !== 'write'
        ) {
          entry.connection.readOnly = true;
          entry.context.access = 'read';
          logger.info('Downgraded a collaboration connection to read-only', {
            documentId: entry.context.documentId,
            userId: entry.context.userId,
          });
        }
      }
    } catch (error) {
      // A failed sweep is a missed net, not a reason to drop everybody.
      logger.error('Collaboration re-authorization sweep failed', error);
    }
  };

  const ready = bus.subscribe((revocation) => {
    apply(revocation);
  });

  const timer = setInterval(() => {
    void recheck();
  }, options.recheckIntervalMs ?? DEFAULT_RECHECK_INTERVAL_MS);
  timer.unref();

  return {
    ready,
    apply,
    recheck,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await bus.close();
    },
  };
}
