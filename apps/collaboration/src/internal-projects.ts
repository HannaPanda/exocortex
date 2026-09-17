import { type IncomingMessage, type ServerResponse } from 'node:http';

import { type Hocuspocus } from '@hocuspocus/server';
import type * as Y from 'yjs';

import {
  readBearerToken,
  resolveCollaborationAccess,
  verifyServiceToken,
  type WorkspaceAccessService,
} from '@exocortex/auth';
import {
  collaborationProjectApplyRequestSchema,
  type CollaborationProjectApplyResponse,
  type CollaborationProjectOperation,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import {
  addProjectAsset,
  deleteProjectPath,
  importProjectFiles,
  moveProjectPath,
  patchProjectTextFile,
  projectFileCount,
  projectHasPath,
  ProjectStateError,
  writeProjectTextFile,
} from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';

/**
 * `POST /internal/projects/:projectId/apply` — every write to a project's file
 * tree that does not come from somebody typing (issue #43, ADR-027).
 *
 * The document endpoint next door mirrors a write the API has already made;
 * this one *is* the write. A project's canonical state is a CRDT, and the only
 * safe way to change a CRDT from outside is to apply an operation to it, not to
 * install a state built somewhere else. So the API sends what it wants done,
 * this process opens the document (Hocuspocus loads it from storage when nobody
 * has it open), applies the operation and lets the ordinary persistence hook
 * write it back.
 *
 * The guards are the document endpoint's, unchanged: loopback only, a
 * short-lived HMAC service token minted for `collaboration-write`, and the
 * token's user re-checked against current workspace membership, so a service
 * token is a way in and never a way around authorization.
 */

const PATH_PATTERN = /^\/internal\/projects\/([^/?]+)\/apply(?:\?.*)?$/;

/**
 * Enough for the largest single text file a project may hold, and no more.
 *
 * An archive import sends many files in one operation and would outgrow this,
 * so the API splits it into batches that fit rather than this number growing to
 * meet the largest archive anyone might upload.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface InternalProjectHandlerOptions {
  prisma: PrismaClient;
  access: WorkspaceAccessService;
  logger: Logger;
  /** Shared with the API; the same secret that signs collaboration tickets. */
  secret: string;
}

class RequestBodyTooLargeError extends Error {}

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
 * How many paths the operation adds.
 *
 * A move and a delete never grow the tree, a patch never does either; only a
 * write and an asset can, and only when the path is new. Counting before
 * applying is what keeps the limit from being enforced one file too late.
 */
function pathsAdded(doc: Y.Doc, operation: CollaborationProjectOperation): number {
  switch (operation.op) {
    case 'write':
    case 'asset':
      return projectHasPath(doc, operation.path) ? 0 : 1;
    case 'import': {
      // Counted over the distinct new paths, so an archive that names the same
      // file twice cannot spend the budget twice.
      const fresh = new Set<string>();
      for (const file of operation.files) {
        if (!projectHasPath(doc, file.path)) fresh.add(file.path);
      }
      return fresh.size;
    }
    default:
      return 0;
  }
}

/** Applies one operation and returns the paths it touched. */
function applyOperation(doc: Y.Doc, operation: CollaborationProjectOperation): string[] {
  switch (operation.op) {
    case 'write':
      writeProjectTextFile(doc, operation.path, operation.content, {
        createOnly: operation.createOnly,
      });
      return [operation.path];
    case 'patch':
      patchProjectTextFile(doc, operation.path, operation.oldText, operation.newText, {
        replaceAll: operation.replaceAll,
      });
      return [operation.path];
    case 'asset':
      addProjectAsset(doc, operation.path, {
        attachmentId: operation.attachmentId,
        byteSize: operation.byteSize,
        mimeType: operation.mimeType,
      });
      return [operation.path];
    case 'move':
      return moveProjectPath(doc, operation.from, operation.to, {
        recursive: operation.recursive,
      });
    case 'delete':
      return deleteProjectPath(doc, operation.path, { recursive: operation.recursive });
    case 'import':
      return importProjectFiles(doc, operation.files, { overwrite: operation.overwrite });
  }
}

export function createInternalProjectHandler(options: InternalProjectHandlerOptions) {
  const logger = options.logger.child({ component: 'internal-projects' });

  return async function handleInternalProjectRequest(
    request: IncomingMessage,
    response: ServerResponse,
    instance: Hocuspocus,
  ): Promise<boolean> {
    const match = PATH_PATTERN.exec(request.url ?? '/');
    if (match === null) return false;
    const projectId = decodeURIComponent(match[1] as string);

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
      logger.warn('Rejected internal project write', { projectId, reason: verification.reason });
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

    const parsed = collaborationProjectApplyRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      respond(response, 400, { error: 'invalid_request' });
      return true;
    }

    const context = await options.access.findDocumentContext(projectId, verification.claims.userId);
    if (context === null || context.document.type !== 'PROJECT') {
      respond(response, 404, { error: 'project_not_found' });
      return true;
    }
    if (resolveCollaborationAccess(context.role, context.document) !== 'write') {
      logger.warn('Internal project write without write access', {
        projectId,
        userId: verification.claims.userId,
      });
      respond(response, 403, { error: 'project_access_denied' });
      return true;
    }

    // A document on its way out is finished off first: Hocuspocus has stored it
    // and is about to destroy the in-memory copy, and opening a connection to
    // that copy would apply the change to something nobody keeps.
    const unloading = instance.unloadingDocuments.get(projectId);
    if (unloading !== undefined) await unloading;

    // Whether anybody had it open *before* this call. Opening a direct
    // connection loads the document, so asking afterwards would always say yes.
    const live = instance.documents.has(projectId);

    const connection = await instance.openDirectConnection(projectId);
    let paths: string[] = [];
    // A holder rather than a plain `let`: the assignment happens inside the
    // transaction callback, and TypeScript would narrow a `let` to `null` for
    // the check that follows it.
    const refusal: { error: ProjectStateError | null } = { error: null };
    try {
      await connection.transact((document) => {
        if (
          projectFileCount(document) + pathsAdded(document, parsed.data.operation) >
          parsed.data.maxFiles
        ) {
          refusal.error = new ProjectStateError(
            'too_many_files',
            `A project may hold at most ${String(parsed.data.maxFiles)} files`,
          );
          return;
        }
        try {
          paths = applyOperation(document, parsed.data.operation);
        } catch (error) {
          if (error instanceof ProjectStateError) {
            refusal.error = error;
            return;
          }
          throw error;
        }
      });

      if (refusal.error !== null) {
        await connection.disconnect();
        // A refused operation, not a broken one: the file was not there, the
        // anchor did not match, the target is taken. 409 so the API can turn
        // the code into the sentence a person or an agent needs.
        respond(response, 409, {
          error: refusal.error.code,
          message: refusal.error.message,
        });
        return true;
      }
    } catch (error) {
      await connection.disconnect();
      logger.error('Failed to apply an operation to a project', error, {
        projectId,
        correlationId: parsed.data.correlationId,
      });
      respond(response, 422, { error: 'apply_failed' });
      return true;
    }

    // Persists immediately: Hocuspocus runs the store hook with a zero debounce
    // on disconnect, so the caller can report a state that is in the database
    // rather than one that is on its way there.
    await connection.disconnect();

    const stored = await options.prisma.documentContent.findUnique({
      where: { documentId: projectId },
      select: { yjsUpdatedAt: true },
    });
    const clientsCount = instance.documents.get(projectId)?.getConnectionsCount() ?? 0;

    logger.info('Applied an operation to a project', {
      projectId,
      op: parsed.data.operation.op,
      paths: paths.length,
      live,
      correlationId: parsed.data.correlationId,
    });

    respond(response, 200, {
      paths,
      clientsCount,
      live,
      yjsUpdatedAt: stored?.yjsUpdatedAt.toISOString() ?? null,
    } satisfies CollaborationProjectApplyResponse);
    return true;
  };
}
