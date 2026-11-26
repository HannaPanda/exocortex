import { AiImageEmptyError, AiProviderError, type ImageGenerator } from '@exocortex/ai';
import {
  type AiRunDiagnosis,
  type AiUsage,
  type DocumentCoverErrorDetail,
  documentSummarySchema,
  type QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';

import { type AiKeyResolver } from '../ai-key';

import { keyRefusalReason } from './ai-run/provider-refusal';
import { type ImageRunRecord, type ImageRunRecorder } from './image-run';

export interface DocumentCoverDependencies {
  /**
   * The generator for the configured model, or `null` when the deployment has
   * none. Built per slug so an admin can change the model without a restart;
   * with an `apiKey` it is paid for by that key instead of the deployment's.
   */
  imageGeneratorFor: (modelSlug: string | null, apiKey?: string) => ImageGenerator | null;
  /** Whose key pays for a picture drawn for this workspace (ADR-023, ADR-090). */
  aiKeyFor: AiKeyResolver;
  /** Writes the picture into the usage report. Never throws. */
  recordImageRun: ImageRunRecorder;
  /**
   * An API client acting as the given user. `null` when the deployment has no
   * service-token secret, which is the same seam that disables the tool loop.
   */
  apiClientFor: ((userId: string) => ExocortexApiClient) | null;
  bus: RedisEventBus;
  settings: (workspaceId?: string) => Promise<Settings>;
}

type CoverJob = JobContext<typeof QUEUE_NAMES.documentCover>;

/** English, for the log and for clients that read `error`. */
function coverErrorMessage(detail: DocumentCoverErrorDetail): string {
  switch (detail.code) {
    case 'unavailable':
      return 'Image generation is not set up for this deployment.';
    case 'no_picture':
      return `The model "${detail.model}" returned no image; it most likely cannot generate images.`;
    case 'key_refused':
      return detail.reason === 'credits'
        ? `The ${detail.ownKey ? "workspace's" : "deployment's"} key has no credits left for a picture.`
        : `The ${detail.ownKey ? "workspace's" : "deployment's"} key was refused.`;
    case 'failed':
      return 'The cover could not be generated.';
  }
}

/** How a failed picture ends: what the page is told and what the usage report records. */
interface CoverFailure {
  detail: DocumentCoverErrorDetail;
  status: ImageRunRecord['status'];
  errorCode: string;
  diagnosis: AiRunDiagnosis | null;
}

/**
 * Reads a failure the way a run's is read (issue #225): a refused key says
 * whose key and why, and nothing steps in for it. A model that answered
 * without a picture is the most likely mistake by far, because the admin
 * setting takes any slug and most of them are text-only; saying so beats
 * "please try again", which would be exactly the wrong advice.
 */
export function coverFailure(error: unknown, model: string, ownKey: boolean): CoverFailure {
  if (error instanceof AiProviderError) {
    if (error.code === 'ai_image_empty') {
      return {
        detail: { code: 'no_picture', model },
        status: 'FAILED',
        errorCode: error.code,
        diagnosis: null,
      };
    }
    const reason = keyRefusalReason(error.status ?? undefined);
    if (reason !== null) {
      return {
        detail: { code: 'key_refused', reason, ownKey },
        status: 'FAILED',
        errorCode: error.code,
        diagnosis: {
          key: 'keyRefused',
          args: { reason, provider: 'openrouter', model, ownKey },
        },
      };
    }
    return { detail: { code: 'failed' }, status: 'FAILED', errorCode: error.code, diagnosis: null };
  }
  const aborted = error instanceof Error && error.name === 'AbortError';
  return {
    detail: { code: 'failed' },
    status: aborted ? 'TIMED_OUT' : 'FAILED',
    errorCode: aborted ? 'ai_timeout' : 'ai_image_failed',
    diagnosis: null,
  };
}

/**
 * Draws a page cover from a prompt and installs it.
 *
 * Four things are worth knowing about the shape here.
 *
 * The picture is paid for like a run (issue #252, ADR-090): with the
 * workspace's own OpenRouter key when it has one, the deployment's only when
 * it has none. A key the provider refuses ends the cover with that reason;
 * no other key steps in.
 *
 * Every picture that was asked of a model is recorded as an `ai_run` row of
 * kind `IMAGE`, whatever came of it, so the usage report shows what covers
 * cost, on whose key and in which workspace.
 *
 * The finished image is uploaded through `POST /api/documents/:id/cover` with a
 * service token minted for the requesting user, not written to the database
 * directly. That is ADR-014's rule applied to a processor: the generated cover
 * passes exactly the permission checks, the magic-byte check and the
 * downscaling an uploaded one does, and a user who lost access to the page
 * between asking and answering does not get a cover installed anyway.
 *
 * And a failure is never retried. Every attempt is a paid call to an image
 * model, so silently drawing the same picture three times is the one behaviour
 * this must not have. The job reports the failure to the browser and ends
 * successfully; asking again is the human's decision.
 */
export function createDocumentCoverProcessor(dependencies: DocumentCoverDependencies) {
  const { bus } = dependencies;

  return async ({ payload, logger }: CoverJob): Promise<void> => {
    // A code, never a sentence: the page words it for its reader (issue #98).
    const publish = async (
      status: 'ready' | 'failed',
      errorDetail: DocumentCoverErrorDetail | null,
    ): Promise<void> => {
      await bus.publish({
        type: 'document.cover.generated',
        workspaceId: payload.workspaceId,
        correlationId: payload.correlationId,
        emittedAt: new Date().toISOString(),
        payload: {
          documentId: payload.documentId,
          status,
          error: errorDetail === null ? null : coverErrorMessage(errorDetail),
          errorDetail,
        },
      });
    };

    const settings = await dependencies.settings(payload.workspaceId);
    const enabled = settings['ai.enabled'] && settings['ai.imageGenerationEnabled'];
    const modelSlug = settings['ai.imageModelSlug'];

    let key: Awaited<ReturnType<AiKeyResolver>>;
    try {
      key = await dependencies.aiKeyFor(payload.workspaceId);
    } catch (error: unknown) {
      logger.error('Could not resolve whose key pays for the cover', error, {
        documentId: payload.documentId,
      });
      await publish('failed', { code: 'failed' });
      return;
    }

    // Only a key the workspace brought builds a generator of its own; without
    // one this is the deployment's, cached per slug.
    const generator = enabled
      ? dependencies.imageGeneratorFor(modelSlug, key.usedOwnKey ? key.apiKey : undefined)
      : null;

    if (generator === null || dependencies.apiClientFor === null) {
      logger.info('Cover generation unavailable', { documentId: payload.documentId });
      await publish('failed', { code: 'unavailable' });
      return;
    }

    // The workspace key is an OpenRouter key; the offline generator spends
    // nobody's money, so it never counts as the workspace's.
    const usedOwnKey = key.usedOwnKey && generator.provider === 'openrouter';
    const apiClient = dependencies.apiClientFor(payload.userId);
    const startedAt = new Date();
    let usage: AiUsage | null = null;
    const record = (outcome: Pick<ImageRunRecord, 'status' | 'errorCode' | 'diagnosis'>) =>
      dependencies.recordImageRun({
        workspaceId: payload.workspaceId,
        documentId: payload.documentId,
        userId: payload.userId,
        prompt: payload.prompt,
        provider: generator.provider,
        model: generator.model,
        usage,
        usedOwnKey,
        startedAt,
        finishedAt: new Date(),
        correlationId: payload.correlationId,
        ...outcome,
      });

    try {
      const image = await generator.generate({
        prompt: payload.prompt,
        timeoutMs: settings['ai.timeoutMs'],
        correlationId: payload.correlationId,
      });
      usage = image.usage;

      const summary = await apiClient.upload({
        path: `/api/documents/${payload.documentId}/cover`,
        filename: 'titelbild.png',
        // The API sniffs the real type from the magic bytes anyway; naming the
        // model's own claim here only helps the multipart parser.
        contentType: image.mimeType,
        bytes: image.data,
        responseSchema: documentSummarySchema,
      });

      logger.info('Cover generated', {
        documentId: payload.documentId,
        model: image.model,
        byteSize: image.data.byteLength,
        attachmentId: summary.coverAttachmentId,
        usedOwnKey,
      });
      await record({ status: 'COMPLETED', errorCode: null, diagnosis: null });
      await publish('ready', null);
    } catch (error) {
      logger.error('Cover generation failed', error, {
        documentId: payload.documentId,
        model: generator.model,
        correlationId: payload.correlationId,
        usedOwnKey,
      });
      if (usage === null && error instanceof AiImageEmptyError) usage = error.usage;
      const failure = coverFailure(error, generator.model, usedOwnKey);
      await record({
        status: failure.status,
        errorCode: failure.errorCode,
        diagnosis: failure.diagnosis,
      });
      await publish('failed', failure.detail);
    }
  };
}
