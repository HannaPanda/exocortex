import {
  type AiProvider,
  distillAnswerMissing,
  MAX_DISTILL_NOTE_TOKENS,
  MAX_DISTILL_TRANSCRIPT_CHARS,
  MEMORY_DISTILL_PROMPT,
  parseMemoryNote,
  renderDistillContext,
  transcriptTail,
} from '@exocortex/ai';
import {
  type MemoryCaptureJobResult,
  memoryRememberResponseSchema,
  type QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type JobContext } from '@exocortex/queue';

/** The distiller gets its own timeout: nobody is waiting, but nothing may hang forever. */
const DISTILL_TIMEOUT_MS = 120_000;

export interface MemoryCaptureDependencies {
  provider: AiProvider;
  /**
   * An API client acting as the given user. `null` when the deployment has no
   * service-token secret, which is the same seam that disables the tool loop.
   */
  apiClientFor: ((userId: string) => ExocortexApiClient) | null;
  settings: (workspaceId?: string) => Promise<Settings>;
  /**
   * Fallback model when no setting names one, usually `OPENROUTER_DEFAULT_MODEL`.
   * `null` leaves the choice to the provider, which has a default of its own.
   */
  defaultModel: string | null;
}

/**
 * Turns one finished working session into one memory note (issue #34, AP1).
 *
 * The raw transcript exists only here, in the job payload, for as long as the
 * job runs. What gets written is the model's summary, through
 * `POST /api/memory/remember` with a service token minted for the capturing
 * user, so an automatically written memory passes exactly the permission checks
 * a hand-typed page does (ADR-014).
 *
 * Every ending is returned as an outcome and kept as the job's return value,
 * which is what `GET /api/memory/capture/:jobId` reads (issue #188): the
 * request that queued the job answered long before anything here was decided.
 *
 * Nothing here throws for a foreseeable outcome. The caller is a hook inside
 * somebody's editor that has long since exited; a failed capture is a memory
 * that was not written, not an incident, and a retry would only pay for the
 * same prompt twice.
 */
export function createMemoryCaptureProcessor(dependencies: MemoryCaptureDependencies) {
  return async ({
    payload,
    logger,
  }: JobContext<typeof QUEUE_NAMES.memoryCapture>): Promise<MemoryCaptureJobResult> => {
    const settings = await dependencies.settings(payload.workspaceId);

    if (!settings['ai.enabled'] || !settings['memory.enabled']) {
      logger.info('Memory capture skipped: the feature is switched off', {
        project: payload.projectKey,
      });
      return { outcome: 'feature_disabled', documentId: null };
    }
    if (dependencies.apiClientFor === null) {
      logger.warn('Memory capture is unavailable: SERVICE_TOKEN_SECRET is not configured');
      return { outcome: 'service_token_missing', documentId: null };
    }

    const model =
      settings['memory.captureModelSlug'] ??
      settings['ai.compactionModelSlug'] ??
      settings['ai.defaultModelSlug'] ??
      dependencies.defaultModel ??
      undefined;

    const transcript = transcriptTail(payload.transcript, MAX_DISTILL_TRANSCRIPT_CHARS);
    const context = renderDistillContext({
      projectKey: payload.projectKey,
      client: payload.client,
      hint: payload.hint,
    });

    let answer: string;
    try {
      const result = await dependencies.provider.generate({
        messages: [
          { role: 'system', content: MEMORY_DISTILL_PROMPT },
          { role: 'user', content: `${context}\n\n---\n\n${transcript}` },
        ],
        model,
        maxOutputTokens: MAX_DISTILL_NOTE_TOKENS,
        temperature: 0.2,
        correlationId: payload.correlationId,
        timeoutMs: DISTILL_TIMEOUT_MS,
      });
      answer = result.text;
      if (distillAnswerMissing(answer)) {
        logger.warn('Memory capture got no text from the model', {
          project: payload.projectKey,
          model,
          finishReason: result.finishReason,
          transcriptChars: payload.transcript.length,
        });
        return { outcome: 'distill_failed', documentId: null };
      }
    } catch (error) {
      logger.warn('Memory capture failed to distil the session', {
        project: payload.projectKey,
        model,
        reason: error instanceof Error ? error.message : String(error),
      });
      return { outcome: 'distill_failed', documentId: null };
    }

    const note = parseMemoryNote(answer);
    if (note === null) {
      logger.info('Memory capture found nothing worth remembering', {
        project: payload.projectKey,
        client: payload.client,
      });
      return { outcome: 'nothing_to_remember', documentId: null };
    }

    try {
      const written = await dependencies.apiClientFor(payload.userId).request({
        method: 'POST',
        path: '/api/memory/remember',
        body: {
          project: payload.projectKey,
          title: note.title,
          text: note.body,
          client: payload.client,
          // One page per session, not one per day: a session is the unit a
          // person recognises again, and its bullet points only make sense
          // together.
          appendToday: false,
          // Dates the note by the session, not by the moment it was distilled.
          // They are the same thing for a live hook and days apart for a
          // transcript replayed after the fact.
          ...(payload.endedAt === null ? {} : { occurredAt: payload.endedAt }),
        },
        responseSchema: memoryRememberResponseSchema,
      });

      logger.info('Session captured as a memory', {
        project: payload.projectKey,
        client: payload.client,
        documentId: written.documentId,
        model,
        transcriptChars: payload.transcript.length,
        noteChars: note.body.length,
      });
      return { outcome: 'written', documentId: written.documentId };
    } catch (error) {
      logger.warn('Memory capture could not write the note', {
        project: payload.projectKey,
        reason: error instanceof Error ? error.message : String(error),
      });
      return { outcome: 'write_failed', documentId: null };
    }
  };
}
