import {
  createAnydocExtractor,
  createImageGenerator,
  createOptionalDoclingPdfExtractor,
  createPdfDocumentInfoReader,
  createPdfTextExtractor,
  createVisionPreprocessor,
  type DocumentTextExtractor,
  type ImageGenerator,
  type PdfDocumentInfoReader,
  type VisionPreprocessor,
} from '@exocortex/ai';
import { type WorkerEnv } from '@exocortex/config';
import { type Settings } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

/**
 * The pieces that turn a file or a prompt into something a model produced:
 * image generation, the vision companions, the PDF text chain and the local
 * office converter.
 *
 * All but the last are cached or built once and have a "not configured" answer
 * rather than an exception, because a deployment is allowed to run without a
 * Docling container or an image model. The office converter has no such answer
 * because it has nothing to configure: it is a library, and it is either
 * installed or the import fails.
 */
export function createMediaFactories(
  env: WorkerEnv,
  logger: Logger,
): {
  imageGeneratorFor: (modelSlug: string | null) => ImageGenerator | null;
  visionPreprocessorFor: (modelSlug: string | null, apiKey?: string) => VisionPreprocessor | null;
  pdfDocumentInfo: PdfDocumentInfoReader;
  pdfExtractorChain: (settings: Settings) => readonly DocumentTextExtractor[];
  officeExtractor: DocumentTextExtractor;
} {
  // Image generation: the model comes from the settings, so an admin can point
  // it at a different one without a restart; the generators are cached per slug
  // exactly like the vision companions below.
  const imageGeneratorCache = new Map<string, ImageGenerator | null>();
  const imageGeneratorFor = (modelSlug: string | null): ImageGenerator | null => {
    const cacheKey = modelSlug ?? '';
    if (!imageGeneratorCache.has(cacheKey)) {
      imageGeneratorCache.set(
        cacheKey,
        createImageGenerator({
          providerId: env.AI_PROVIDER,
          logger,
          appUrl: env.APP_URL,
          apiKey: env.OPENROUTER_API_KEY ?? '',
          baseUrl: env.OPENROUTER_BASE_URL,
          model: modelSlug,
        }),
      );
    }
    return imageGeneratorCache.get(cacheKey) ?? null;
  };

  // Vision companions (ADR-012): a per-model factory, cached, so a run can pass
  // its own companion slug (conversation override, or the model row's admin
  // default) instead of only ever the one env-configured model.
  const visionPreprocessorCache = new Map<string, VisionPreprocessor | null>();
  const visionPreprocessorFor = (
    modelSlug: string | null,
    apiKey?: string,
  ): VisionPreprocessor | null => {
    const effectiveModel = modelSlug ?? env.OPENROUTER_VISION_MODEL;
    const cacheKey = effectiveModel ?? '';
    // A run that pays with its own key gets its own preprocessor. Not cached:
    // the cache is keyed by model, and holding secrets in it would either leak
    // one workspace's key into another's call or need the key in the cache key.
    if (apiKey !== undefined && apiKey !== (env.OPENROUTER_API_KEY ?? '')) {
      return createVisionPreprocessor({
        logger,
        appUrl: env.APP_URL,
        apiKey,
        baseUrl: env.OPENROUTER_BASE_URL,
        model: effectiveModel,
      });
    }
    if (!visionPreprocessorCache.has(cacheKey)) {
      visionPreprocessorCache.set(
        cacheKey,
        createVisionPreprocessor({
          logger,
          appUrl: env.APP_URL,
          apiKey: env.OPENROUTER_API_KEY ?? '',
          baseUrl: env.OPENROUTER_BASE_URL,
          model: effectiveModel,
        }),
      );
    }
    return visionPreprocessorCache.get(cacheKey) ?? null;
  };

  // The PDF's own metadata dictionary, read locally from the file. Not an
  // engine and not part of the chain below: it produces no text, and it must
  // stay independent of which engine does, so that choosing the free local
  // engine does not cost the title, the author and the dates.
  const pdfDocumentInfo = createPdfDocumentInfoReader({ logger });

  // PDF text extraction (D6): built once at boot from the main driver model --
  // the OpenRouter file-parser plugin works with any model, so the deployment
  // does not need a dedicated env var for it. `ai.pdfExtractionModelSlug`
  // (DB-configurable) is not yet wired here: doing so would mean rebuilding the
  // extractor per job the way `visionPreprocessorFor` does, which is a
  // reasonable follow-up but out of scope for tonight (see docs/ai-architecture.md).
  const openRouterPdfExtractor = createPdfTextExtractor({
    apiKey: env.OPENROUTER_API_KEY ?? '',
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.OPENROUTER_DEFAULT_MODEL,
    appUrl: env.APP_URL,
    logger,
  });

  // Local Docling instance. Null unless DOCLING_BASE_URL is set, which is what
  // keeps the ~7.7 GB container optional for a deployment that does not need OCR.
  const doclingPdfExtractor = createOptionalDoclingPdfExtractor({
    baseUrl: env.DOCLING_BASE_URL,
    logger,
  });

  /**
   * Engines to try, in order, for one PDF.
   *
   * The setting names the primary; the other engine backs it up, in either
   * direction. The symmetry matters both ways: Docling first needs the hosted
   * engine for the day the container is down, and OpenRouter first needs
   * Docling for every scan.
   *
   * Both factories return null when their side is unconfigured, and an empty
   * chain is how the processor learns that PDF extraction is unavailable -- so
   * a deployment with neither says so plainly instead of failing per document.
   */
  const pdfExtractorChain = (settings: Settings): readonly DocumentTextExtractor[] => {
    const [primary, fallback] =
      settings['ai.pdfExtractor'] === 'openrouter'
        ? [openRouterPdfExtractor, doclingPdfExtractor]
        : [doclingPdfExtractor, openRouterPdfExtractor];
    const chain: DocumentTextExtractor[] = [];
    if (primary !== null) chain.push(primary);
    if (settings['ai.pdfExtractorFallbackEnabled'] && fallback !== null) chain.push(fallback);
    return chain;
  };

  // No configuration seam of its own: the converter is a library call with
  // no endpoint and no key, so the only question a deployment gets to answer
  // is `ai.officeExtractionEnabled`, and the processor asks that one.
  const officeExtractor = createAnydocExtractor({ logger });

  return {
    imageGeneratorFor,
    visionPreprocessorFor,
    pdfDocumentInfo,
    pdfExtractorChain,
    officeExtractor,
  };
}
