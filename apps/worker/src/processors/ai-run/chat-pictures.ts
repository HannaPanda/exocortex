import { type DecisionProvider, type VisionPreprocessor } from '@exocortex/ai';
import { type QUEUE_NAMES, type Settings } from '@exocortex/contracts';
import { type AiRun, type PrismaClient } from '@exocortex/database';
import { type JobContext } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { describeChatAttachments, transcriptCarriesForeignChatFiles } from './chat-attachments';
import { type ChatImagePixels, chatImagePixelsFor } from './chat-images';
import { type ResolvedModelRow } from './contract';
import { MAX_IMAGES_PER_RUN } from './images';
import { resolveImageDescriber } from './preparation';

/**
 * What a run does with the pictures on its conversation before the prompt is
 * built (issue #223): describes the ones nobody has described yet with the
 * describer a tool's picture gets (ADR-088), screens each new description
 * (ADR-096), and chooses whether a model that sees gets them as pixels
 * (ADR-097). Answers the pixel reader, and whether the prompt now carries a
 * picture that is not the requester's own screened upload.
 */
export async function prepareChatPictures(input: {
  dependencies: {
    prisma: PrismaClient;
    storage: ObjectStorage;
    visionPreprocessorFor: (modelSlug: string | null, apiKey: string) => VisionPreprocessor | null;
    /** Who screens a new description; none leaves it unscreened, hence foreign. */
    decisionsFor?: (apiKey: string) => DecisionProvider | null;
  };
  run: AiRun;
  settings: Settings;
  modelRow: ResolvedModelRow;
  conversationCompanionSlug: string | null;
  /** The run's key, which pays for describing and screening. */
  apiKey: string;
  correlationId: string;
  logger: JobContext<typeof QUEUE_NAMES.ai>['logger'];
}): Promise<{ pixels: ChatImagePixels | null; foreign: boolean }> {
  const { run, settings, dependencies, apiKey } = input;
  const maxImages = settings['ai.visionMaxImagesPerRun'] ?? MAX_IMAGES_PER_RUN;
  if (run.conversationId === null) return { pixels: null, foreign: false };
  const pixels = chatImagePixelsFor({
    sendImagesToModel: settings['ai.sendImagesToModel'],
    supportsVision: input.modelRow.supportsVision,
    conversationId: run.conversationId,
    storage: dependencies.storage,
    maxImages,
    logger: input.logger,
  });
  // Described even when the pixels go: the description is what a text-only
  // model, a compaction, a refused turn and the screening read.
  await describeChatAttachments({
    prisma: dependencies.prisma,
    storage: dependencies.storage,
    describer: resolveImageDescriber({
      settings,
      modelRow: input.modelRow,
      conversationCompanionSlug: input.conversationCompanionSlug,
      visionPreprocessorFor: (modelSlug) => dependencies.visionPreprocessorFor(modelSlug, apiKey),
      correlationId: input.correlationId,
    }),
    decisions: dependencies.decisionsFor?.(apiKey) ?? null,
    conversationId: run.conversationId,
    maxImages,
    correlationId: input.correlationId,
    logger: input.logger,
  });
  const foreign = await transcriptCarriesForeignChatFiles(
    dependencies.prisma,
    run.conversationId,
    run.createdById,
    pixels !== null,
  );
  return { pixels, foreign };
}
