import { Database } from '@hocuspocus/extension-database';
import { Server } from '@hocuspocus/server';

import {
  resolveCollaborationAccess,
  verifyCollaborationTicket,
  WorkspaceAccessService,
} from '@exocortex/auth';
import { type CollaborationAccess } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { type QueueRegistry } from '@exocortex/queue';

import { DocumentPersistence } from './persistence';

/** Context attached to every authenticated collaboration connection. */
export interface CollaborationContext {
  userId: string;
  documentId: string;
  workspaceId: string;
  access: CollaborationAccess;
}

export interface CreateCollaborationServerOptions {
  prisma: PrismaClient;
  queues: QueueRegistry;
  logger: Logger;
  ticketSecret: string;
  port: number;
  address?: string;
  /** Debounce for persisting the binary state, in milliseconds. */
  storeDebounceMs?: number;
  storeMaxDebounceMs?: number;
}

/**
 * Signals to Hocuspocus that a plain HTTP request was fully handled by our own
 * hook. Hocuspocus stops processing a request when an `onRequest` hook rejects.
 */
class RequestHandledSignal extends Error {
  constructor() {
    super('Request handled by the health endpoint');
    this.name = 'RequestHandledSignal';
  }
}

export class CollaborationAuthenticationError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CollaborationAuthenticationError';
    this.code = code;
  }
}

/**
 * Builds the Hocuspocus server.
 *
 * Authorization happens entirely on the server:
 *  1. the ticket signature, expiry and document scope are verified
 *  2. the document is loaded and must exist
 *  3. workspace membership is re-checked, so a revoked member cannot keep using
 *     a ticket that is still within its TTL
 *  4. the effective access is the *minimum* of the ticket claim and the current
 *     policy decision, so a ticket can never widen permissions
 */
export function createCollaborationServer(options: CreateCollaborationServerOptions): Server<CollaborationContext> {
  const logger = options.logger.child({ component: 'collaboration-server' });
  const access = new WorkspaceAccessService(options.prisma);
  const persistence = new DocumentPersistence({
    prisma: options.prisma,
    queues: options.queues,
    logger: options.logger,
  });

  return new Server<CollaborationContext>({
    name: 'exocortex-collaboration',
    port: options.port,
    address: options.address ?? '127.0.0.1',
    quiet: true,
    // Hocuspocus debounces persistence; the derived materialization job is
    // debounced again in the queue layer.
    debounce: options.storeDebounceMs ?? 2_000,
    maxDebounce: options.storeMaxDebounceMs ?? 10_000,
    // Signals are handled by main.ts so shutdown order is explicit.
    stopOnSignals: false,

    async onAuthenticate(data) {
      const documentId = data.documentName;
      const verification = verifyCollaborationTicket({
        secret: options.ticketSecret,
        ticket: data.token,
        expectedDocumentId: documentId,
      });

      if (!verification.valid) {
        logger.warn('Rejected collaboration connection', {
          documentId,
          reason: verification.reason,
          socketId: data.socketId,
        });
        throw new CollaborationAuthenticationError(
          verification.reason === 'expired'
            ? 'collaboration_ticket_expired'
            : 'collaboration_ticket_invalid',
          `Collaboration ticket rejected: ${verification.reason}`,
        );
      }

      const context = await access.findDocumentContext(documentId, verification.claims.userId);
      if (context === null) {
        logger.warn('Collaboration connection for inaccessible document', {
          documentId,
          userId: verification.claims.userId,
        });
        throw new CollaborationAuthenticationError(
          'document_access_denied',
          'Document does not exist or the user is no longer a workspace member',
        );
      }

      const policyAccess = resolveCollaborationAccess(context.role, context.document);
      const effectiveAccess: CollaborationAccess =
        verification.claims.access === 'write' && policyAccess === 'write' ? 'write' : 'read';

      if (effectiveAccess === 'read') {
        // Hocuspocus rejects incoming document updates on read-only connections.
        data.connectionConfig.readOnly = true;
      }

      logger.info('Collaboration connection authenticated', {
        documentId,
        userId: verification.claims.userId,
        workspaceId: context.workspaceId,
        access: effectiveAccess,
        socketId: data.socketId,
      });

      return {
        userId: verification.claims.userId,
        documentId,
        workspaceId: context.workspaceId,
        access: effectiveAccess,
      } satisfies CollaborationContext;
    },

    extensions: [
      new Database({
        fetch: async ({ documentName }) => persistence.fetch(documentName),
        store: async ({ documentName, state }) => {
          await persistence.store({ documentId: documentName, state });
        },
      }),
    ],

    async onDisconnect(data) {
      logger.debug('Collaboration connection closed', {
        documentId: data.documentName,
        socketId: data.socketId,
        clientsCount: data.clientsCount,
      });
    },

    /**
     * Plain HTTP requests are only used for health probes. Awareness data is
     * never persisted and never exposed here.
     */
    async onRequest(data) {
      const url = data.request.url ?? '/';
      if (url.startsWith('/health/live')) {
        data.response.writeHead(200, { 'content-type': 'application/json' });
        data.response.end(JSON.stringify({ status: 'ok' }));
        throw new RequestHandledSignal();
      }
      if (url.startsWith('/health/ready')) {
        let databaseReady = false;
        try {
          await options.prisma.$queryRaw`SELECT 1`;
          databaseReady = true;
        } catch (error) {
          logger.error('Collaboration readiness check failed', error);
        }
        data.response.writeHead(databaseReady ? 200 : 503, {
          'content-type': 'application/json',
        });
        data.response.end(JSON.stringify({ status: databaseReady ? 'ok' : 'unavailable' }));
        throw new RequestHandledSignal();
      }
    },
  });
}
