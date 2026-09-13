import { Inject, Injectable } from '@nestjs/common';

import { issueServiceToken } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  collaborationProjectApplyPath,
  type CollaborationProjectApplyResponse,
  collaborationProjectApplyResponseSchema,
  type CollaborationProjectOperation,
} from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { API_ENV, LOGGER } from '../common/logger.provider';

/**
 * The API's half of the project bridge (issue #43, ADR-027).
 *
 * Every write to a project's file tree goes through here, and unlike the page
 * bridge next door this is not a mirror of a write already made: it *is* the
 * write. The collaboration server owns the CRDT, loads it when nobody has it
 * open, applies the operation and persists it. Two writers for one Yjs state
 * would mean the API rebuilding a project's binary state from the rows it
 * derived from that state, which ADR-005 forbids.
 *
 * The consequence is that a failure here fails the request, where a failed page
 * bridge only loses the live update. That is the right trade: a project write
 * that silently did nothing would be worse than one that says so.
 */

/**
 * Long enough for the collaboration server to load a large project, apply and
 * flush; short enough that a hung process cannot hold a request open.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/** The token exists for the duration of one request. */
const TOKEN_TTL_SECONDS = 30;

/**
 * What the collaboration server refuses an operation for, in German.
 *
 * The codes come from `ProjectStateError` and describe a refusal, not a fault:
 * the file is not there, the anchor did not match, the target is taken. Turning
 * them into sentences here is what lets both a person and an agent read the
 * same answer -- the agent gets the code in the error payload as well.
 */
function refusal(code: string, detail: string | null): AppError {
  switch (code) {
    case 'file_not_found':
      return new AppError('project_file_not_found', 'Diese Datei gibt es im Projekt nicht.');
    case 'file_exists':
      return new AppError('project_file_exists', 'An dieser Stelle liegt schon eine Datei.');
    case 'not_a_text_file':
      return new AppError(
        'project_not_a_text_file',
        'Diese Datei ist keine Textdatei und lässt sich so nicht bearbeiten.',
      );
    case 'patch_not_found':
      return new AppError(
        'project_patch_not_found',
        'Der zu ersetzende Text kommt in der Datei nicht vor.',
      );
    case 'patch_not_unique':
      return new AppError(
        'project_patch_not_unique',
        'Der zu ersetzende Text kommt mehrfach vor; mit mehr Kontext eindeutig machen oder alle ersetzen.',
        { detail },
      );
    case 'too_many_files':
      return new AppError(
        'project_too_many_files',
        'Das Projekt hat die erlaubte Anzahl Dateien erreicht.',
      );
    default:
      return new AppError('project_write_failed', 'Die Änderung am Projekt wurde abgelehnt.');
  }
}

@Injectable()
export class ProjectBridgeService {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async apply(input: {
    projectId: string;
    /** Whose access the collaboration server re-checks before applying. */
    userId: string;
    operation: CollaborationProjectOperation;
    maxFiles: number;
    correlationId: string;
  }): Promise<CollaborationProjectApplyResponse> {
    const { token } = issueServiceToken({
      secret: this.env.COLLABORATION_TICKET_SECRET,
      userId: input.userId,
      purpose: 'collaboration-write',
      ttlSeconds: TOKEN_TTL_SECONDS,
    });

    let response: Response;
    try {
      response = await fetch(
        new URL(
          collaborationProjectApplyPath(input.projectId),
          this.env.COLLABORATION_INTERNAL_URL,
        ).toString(),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            operation: input.operation,
            maxFiles: input.maxFiles,
            correlationId: input.correlationId,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      this.logger.error('Collaboration server unreachable for a project write', error, {
        projectId: input.projectId,
        correlationId: input.correlationId,
      });
      throw new AppError(
        'collaboration_unavailable',
        'Der Kollaborationsdienst ist gerade nicht erreichbar, die Änderung wurde nicht gespeichert',
      );
    }

    if (response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      throw refusal(body.error ?? '', body.message ?? null);
    }

    if (!response.ok) {
      this.logger.error('Collaboration server refused a project write', undefined, {
        projectId: input.projectId,
        correlationId: input.correlationId,
        status: response.status,
      });
      throw new AppError(
        'project_write_failed',
        'Die Änderung am Projekt konnte nicht angewendet werden',
      );
    }

    const parsed = collaborationProjectApplyResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new AppError(
        'project_write_failed',
        'Die Änderung am Projekt konnte nicht angewendet werden',
      );
    }
    return parsed.data;
  }
}
