import { type IncomingMessage, type ServerResponse } from 'node:http';

import { type Hocuspocus } from '@hocuspocus/server';

import {
  readBearerToken,
  resolveCollaborationAccess,
  verifyServiceToken,
  type WorkspaceAccessService,
} from '@exocortex/auth';
import {
  collaborationApplyRequestSchema,
  type CollaborationApplyResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import {
  applyBlockRangeEditToYDoc,
  applyProseMirrorDocumentToYDoc,
  type ProseMirrorDocument,
} from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';

import { announceChange, announceRefusal, captureBeforeEdit } from './edit-notices';

/**
 * `POST /internal/documents/:documentId/content` — the collaboration server's
 * only write entrance besides the WebSocket (ADR-016).
 *
 * Before this existed, every write that did not come from an editor went
 * straight to `documentContent.yjsState` in the database. A document that was
 * open at that moment knew nothing about it: readers kept seeing the old text,
 * and the session's next debounced autosave wrote its own in-memory state back
 * over the change. This endpoint closes both halves at once by making the
 * *living* document the thing that gets edited; persistence then follows the
 * ordinary path.
 *
 * It is deliberately narrow:
 *  * loopback only (the process binds `127.0.0.1`), never proxied
 *  * a short-lived HMAC service token minted for `collaboration-write`
 *  * the token's user still has to pass the same write-access check a
 *    WebSocket connection passes, so a service token is a way *in*, never a way
 *    around authorization
 *  * documents that are not loaded here are left alone: nothing is open, so the
 *    caller's own database write is already the whole truth
 */

const PATH_PATTERN = /^\/internal\/documents\/([^/?]+)\/content(?:\?.*)?$/;

/**
 * Generous enough for the largest Markdown a write may carry (2 million
 * characters) once it has become ProseMirror JSON, small enough that a stuck or
 * hostile client cannot exhaust memory.
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface InternalContentHandlerOptions {
  prisma: PrismaClient;
  access: WorkspaceAccessService;
  logger: Logger;
  /** Shared with the API; the same secret that signs collaboration tickets. */
  secret: string;
}

class RequestBodyTooLargeError extends Error {}

/** Reads the whole request body, refusing anything above the limit. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * Builds the request handler.
 *
 * Returns `true` when the request was this endpoint's and a response was
 * written, `false` when the URL belongs to somebody else.
 */
export function createInternalContentHandler(options: InternalContentHandlerOptions) {
  const logger = options.logger.child({ component: 'internal-content' });

  return async function handleInternalContentRequest(
    request: IncomingMessage,
    response: ServerResponse,
    instance: Hocuspocus,
  ): Promise<boolean> {
    const match = PATH_PATTERN.exec(request.url ?? '/');
    if (match === null) return false;
    const documentId = decodeURIComponent(match[1] as string);

    if (request.method !== 'POST') {
      respond(response, 405, { error: 'method_not_allowed' });
      return true;
    }

    const token = readBearerToken(request.headers as Record<string, string | string[] | undefined>);
    if (token === null) {
      respond(response, 401, { error: 'service_token_missing' });
      return true;
    }

    const verification = verifyServiceToken({
      secret: options.secret,
      token,
      expectedPurpose: 'collaboration-write',
    });
    if (!verification.valid) {
      logger.warn('Rejected internal content write', { documentId, reason: verification.reason });
      respond(response, 401, { error: 'service_token_invalid' });
      return true;
    }

    let raw: string;
    try {
      raw = await readBody(request);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        respond(response, 413, { error: 'payload_too_large' });
        return true;
      }
      throw error;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      respond(response, 400, { error: 'invalid_json' });
      return true;
    }

    const parsed = collaborationApplyRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      respond(response, 400, { error: 'invalid_request' });
      return true;
    }

    // Same authorization a WebSocket connection gets: workspace membership is
    // re-read here rather than trusted from the caller, and an archived page
    // resolves to read-only for everybody.
    const context = await options.access.findDocumentContext(
      documentId,
      verification.claims.userId,
    );
    if (context === null) {
      respond(response, 404, { error: 'document_not_found' });
      return true;
    }
    if (resolveCollaborationAccess(context.role, context.document) !== 'write') {
      logger.warn('Internal content write without write access', {
        documentId,
        userId: verification.claims.userId,
      });
      respond(response, 403, { error: 'document_access_denied' });
      return true;
    }

    // A document that is on its way out is finished off first rather than
    // applied to: Hocuspocus has already stored it and is about to destroy the
    // in-memory copy, and applying to a destroyed document would throw. Waiting
    // means the answer describes a settled state instead of a moving one.
    const unloading = instance.unloadingDocuments.get(documentId);
    if (unloading !== undefined) await unloading;

    // Nothing is open here, so there is no live state to correct and no autosave
    // that could overwrite the caller. Reporting that plainly is the answer.
    if (!instance.documents.has(documentId)) {
      respond(response, 200, {
        applied: false,
        clientsCount: 0,
        yjsUpdatedAt: null,
      } satisfies CollaborationApplyResponse);
      return true;
    }

    // The people with the page open are told what changed and by whom
    // (issue #112), which needs the page as it was before the change.
    const notice = {
      instance,
      prisma: options.prisma,
      documentId,
      actor: parsed.data.actor,
      userId: verification.claims.userId,
    };
    const before = captureBeforeEdit(notice);

    const connection = await instance.openDirectConnection(documentId);
    try {
      await connection.transact((document) => {
        const content = parsed.data.proseMirrorJson as ProseMirrorDocument;
        // A narrow write addresses blocks of the live document, which is not
        // the document the API read -- so this can fail where the database
        // write succeeded, and that failure is the honest answer (issue #111).
        if (parsed.data.edit !== null) {
          applyBlockRangeEditToYDoc(document, content, parsed.data.edit);
          return;
        }
        applyProseMirrorDocumentToYDoc(document, content, parsed.data.mode);
      });
    } catch (error) {
      await connection.disconnect();
      logger.error('Failed to apply content to the live document', error, {
        documentId,
        correlationId: parsed.data.correlationId,
      });
      await announceRefusal(notice, parsed.data.edit);
      respond(response, 422, { error: 'apply_failed' });
      return true;
    }

    // Persists immediately (Hocuspocus runs the store hook with a zero
    // debounce on disconnect) instead of leaving the change in memory for the
    // next debounce window, so the caller can report a `yjsUpdatedAt` that is
    // actually in the database.
    await connection.disconnect();

    const stored = await options.prisma.documentContent.findUnique({
      where: { documentId },
      select: { yjsUpdatedAt: true },
    });
    const clientsCount = instance.documents.get(documentId)?.getConnectionsCount() ?? 0;

    // After the store, so the update the notice describes has already gone
    // down the same socket ahead of it.
    await announceChange(notice, before);

    logger.info('Applied content to the live document', {
      documentId,
      mode: parsed.data.mode,
      clientsCount,
      correlationId: parsed.data.correlationId,
    });

    respond(response, 200, {
      applied: true,
      clientsCount,
      yjsUpdatedAt: stored?.yjsUpdatedAt.toISOString() ?? null,
    } satisfies CollaborationApplyResponse);
    return true;
  };
}
