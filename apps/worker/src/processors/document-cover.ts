import { AiProviderError, type ImageGenerator } from '@exocortex/ai';
import { documentSummarySchema, type QUEUE_NAMES, type Settings } from '@exocortex/contracts';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';

export interface DocumentCoverDependencies {
  /**
   * The generator for the configured model, or `null` when the deployment has
   * none. Built per slug so an admin can change the model without a restart.
   */
  imageGeneratorFor: (modelSlug: string | null) => ImageGenerator | null;
  /**
   * An API client acting as the given user. `null` when the deployment has no
   * service-token secret, which is the same seam that disables the tool loop.
   */
  apiClientFor: ((userId: string) => ExocortexApiClient) | null;
  bus: RedisEventBus;
  settings: (workspaceId?: string) => Promise<Settings>;
}

/**
 * Draws a page cover from a prompt and installs it.
 *
 * Two things are worth knowing about the shape here.
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

  return async ({
    payload,
    logger,
  }: JobContext<typeof QUEUE_NAMES.documentCover>): Promise<void> => {
    const publish = async (status: 'ready' | 'failed', error: string | null): Promise<void> => {
      await bus.publish({
        type: 'document.cover.generated',
        workspaceId: payload.workspaceId,
        correlationId: payload.correlationId,
        emittedAt: new Date().toISOString(),
        payload: { documentId: payload.documentId, status, error },
      });
    };

    const settings = await dependencies.settings(payload.workspaceId);
    const generator =
      settings['ai.enabled'] && settings['ai.imageGenerationEnabled']
        ? dependencies.imageGeneratorFor(settings['ai.imageModelSlug'])
        : null;

    if (generator === null || dependencies.apiClientFor === null) {
      logger.info('Cover generation unavailable', { documentId: payload.documentId });
      await publish('failed', 'Die Bilderzeugung ist für diese Instanz nicht eingerichtet.');
      return;
    }

    try {
      const image = await generator.generate({
        prompt: payload.prompt,
        timeoutMs: settings['ai.timeoutMs'],
        correlationId: payload.correlationId,
      });

      const summary = await dependencies.apiClientFor(payload.userId).upload({
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
      });
      await publish('ready', null);
    } catch (error) {
      logger.error('Cover generation failed', error, {
        documentId: payload.documentId,
        model: generator.model,
        correlationId: payload.correlationId,
      });
      // The most likely mistake by far is a model that cannot draw: the admin
      // setting takes any slug, and most of them are text-only. Saying so beats
      // "please try again", which would be exactly the wrong advice.
      const answeredWithoutPicture =
        error instanceof AiProviderError && error.code === 'ai_image_empty';
      await publish(
        'failed',
        answeredWithoutPicture
          ? `Das Modell „${generator.model}" hat kein Bild geliefert. Es kann vermutlich keine Bilder erzeugen; im Administrationsbereich lässt sich ein bildfähiges Modell eintragen.`
          : 'Das Titelbild konnte nicht erzeugt werden. Bitte erneut versuchen.',
      );
    }
  };
}
