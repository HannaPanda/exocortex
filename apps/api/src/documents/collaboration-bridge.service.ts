import { Inject, Injectable } from '@nestjs/common';

import { issueServiceToken } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type CollaborationApplyMode,
  collaborationApplyPath,
  type CollaborationApplyRequest,
  collaborationApplyResponseSchema,
} from '@exocortex/contracts';
import { type ProseMirrorDocument } from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';

import { API_ENV, LOGGER } from '../common/logger.provider';

/**
 * Long enough for the collaboration server to apply the change and flush it to
 * PostgreSQL, short enough that a hung process cannot hold a write request open.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** The token exists for the duration of one request; it needs no more life. */
const TOKEN_TTL_SECONDS = 30;

export interface ApplyToLiveSessionResult {
  /** The document was open here and the live session now carries the change. */
  applied: boolean;
  /** Editors connected to the document at that moment. */
  clientsCount: number;
  /** The timestamp the collaboration server persisted, when it applied. */
  yjsUpdatedAt: string | null;
  /** `false` when the collaboration server could not be reached at all. */
  reachable: boolean;
}

/**
 * The API's half of the bridge to the collaboration server (ADR-016).
 *
 * A write that does not come from the editor (the content endpoint, MCP, the
 * built-in AI, a snapshot restore) changes `documentContent.yjsState` in the
 * database. That is the whole story only while nobody has the page open: an
 * open Hocuspocus session holds its own copy in memory, shows the old text, and
 * writes that copy back on its next autosave. So after committing, the API hands
 * the same change to the collaboration server, which applies it to the living
 * document. Connected editors see it immediately and their autosave now carries
 * it instead of undoing it.
 *
 * A failure here never fails the write. The database already holds the new
 * content; what is lost is only the live update, and the caller is told so.
 */
@Injectable()
export class CollaborationBridgeService {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async applyToLiveSession(input: {
    documentId: string;
    /** Whose access the collaboration server re-checks before applying. */
    userId: string;
    mode: CollaborationApplyMode;
    /**
     * For `replace` the whole new document, for `append` and `prepend` only the
     * nodes to add — inserting instead of rewriting is what lets a session keep
     * everything its users typed in the meantime.
     */
    proseMirrorJson: ProseMirrorDocument;
    correlationId: string;
  }): Promise<ApplyToLiveSessionResult> {
    const unreachable: ApplyToLiveSessionResult = {
      applied: false,
      clientsCount: 0,
      yjsUpdatedAt: null,
      reachable: false,
    };

    const { token } = issueServiceToken({
      secret: this.env.COLLABORATION_TICKET_SECRET,
      userId: input.userId,
      purpose: 'collaboration-write',
      ttlSeconds: TOKEN_TTL_SECONDS,
    });

    const body: CollaborationApplyRequest = {
      proseMirrorJson: input.proseMirrorJson,
      mode: input.mode,
      correlationId: input.correlationId,
    };

    let response: Response;
    try {
      response = await fetch(
        new URL(
          collaborationApplyPath(input.documentId),
          this.env.COLLABORATION_INTERNAL_URL,
        ).toString(),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      this.logger.warn('Collaboration server unreachable for a live update', {
        documentId: input.documentId,
        correlationId: input.correlationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return unreachable;
    }

    if (!response.ok) {
      this.logger.warn('Collaboration server refused a live update', {
        documentId: input.documentId,
        correlationId: input.correlationId,
        status: response.status,
      });
      return unreachable;
    }

    const parsed = collaborationApplyResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      this.logger.warn('Collaboration server returned an unexpected response', {
        documentId: input.documentId,
        correlationId: input.correlationId,
      });
      return unreachable;
    }

    if (parsed.data.applied) {
      this.logger.debug('Live session updated', {
        documentId: input.documentId,
        correlationId: input.correlationId,
        clientsCount: parsed.data.clientsCount,
      });
    }

    return { ...parsed.data, reachable: true };
  }
}
