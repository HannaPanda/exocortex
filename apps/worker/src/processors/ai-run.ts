import { type AiProvider, type VisionPreprocessor } from '@exocortex/ai';
import { type AiMessage, aiMessageSchema, type AiUsage, type QUEUE_NAMES } from '@exocortex/contracts';
import { Prisma, type PrismaClient } from '@exocortex/database';
import { type ProseMirrorNode } from '@exocortex/editor';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

export interface AiRunDependencies {
  prisma: PrismaClient;
  provider: AiProvider;
  bus: RedisEventBus;
  /** Hard timeout for a single run. */
  timeoutMs?: number;
  /** `null` skips image preprocessing entirely (unconfigured, see registry.ts). */
  visionPreprocessor: VisionPreprocessor | null;
  storage: ObjectStorage;
}

/** No page needs more than this many images described for one answer. */
const MAX_IMAGES_PER_RUN = 4;

const ATTACHMENT_DOWNLOAD_PATH = /^\/api\/attachments\/([^/]+)\/download$/;

/** Depth-first collection of every `image` node's `src` attribute. */
function collectImageSources(node: ProseMirrorNode | null | undefined): string[] {
  if (node === null || node === undefined) return [];
  const sources: string[] = [];
  if (node.type === 'image' && typeof node.attrs?.src === 'string' && node.attrs.src.length > 0) {
    sources.push(node.attrs.src);
  }
  for (const child of node.content ?? []) sources.push(...collectImageSources(child));
  return sources;
}

/**
 * Describes the images in a document through the vision preprocessor, so a
 * text-only main driver can use them as context.
 *
 * Best-effort throughout: a document that fails to load, an attachment that
 * cannot be resolved or a single failed description never fails the run --
 * they are logged and skipped, and the text answer proceeds either with
 * fewer images described or with none (docs/adr/ADR-012-vision-preprocessing.md).
 */
async function describeDocumentImages(input: {
  prisma: PrismaClient;
  storage: ObjectStorage;
  visionPreprocessor: VisionPreprocessor;
  workspaceId: string;
  documentId: string;
  correlationId: string;
  logger: { info: (message: string, context?: Record<string, unknown>) => void };
}): Promise<AiMessage | null> {
  const { prisma, storage, visionPreprocessor, workspaceId, documentId, correlationId, logger } =
    input;

  const content = await prisma.documentContent.findUnique({
    where: { documentId },
    select: { proseMirrorJson: true },
  });
  const sources = collectImageSources(content?.proseMirrorJson as ProseMirrorNode | null);
  if (sources.length === 0) return null;

  const truncated = sources.slice(0, MAX_IMAGES_PER_RUN);
  if (sources.length > truncated.length) {
    logger.info('Describing only the first images on the page', {
      documentId,
      total: sources.length,
      described: truncated.length,
    });
  }

  const descriptions: string[] = [];
  for (const src of truncated) {
    const attachmentId = ATTACHMENT_DOWNLOAD_PATH.exec(src)?.[1];
    if (attachmentId === undefined) continue;

    // Scoped to the run's own workspace and document: a src attribute is part
    // of stored document JSON, not user input, but this keeps a stale or
    // forged reference from reaching another workspace's attachment.
    const attachment = await prisma.attachment.findFirst({
      where: { id: attachmentId, workspaceId, documentId, deletedAt: null },
    });
    if (attachment === null || !attachment.mimeType.startsWith('image/')) continue;

    try {
      const stream = await storage.getObject({ key: attachment.storageKey });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      const description = await visionPreprocessor.describeImage({
        data: Buffer.concat(chunks),
        mimeType: attachment.mimeType,
        label: attachment.filename,
        correlationId,
        timeoutMs: 20_000,
      });
      if (description.length > 0) {
        descriptions.push(`${attachment.filename}: ${description}`);
      }
    } catch (error) {
      logger.info('Skipping an image that could not be described', {
        documentId,
        attachmentId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (descriptions.length === 0) return null;
  return {
    role: 'system',
    content:
      'Image context from the current page, described by a separate vision model -- ' +
      "you cannot see these images directly, only this description:\n\n" +
      descriptions.map((description, index) => `${index + 1}. ${description}`).join('\n'),
  };
}

/**
 * Executes an AI run outside the API process.
 *
 * The provider is behind the `AiProvider` contract, so switching from the mock
 * provider to a real one changes configuration only. CLI agents (Claude Code,
 * Codex) will be executed from here too, inside their own isolated sandbox, and
 * never inside the API or the Next.js server (docs/ai-architecture.md).
 */
export function createAiRunProcessor(dependencies: AiRunDependencies) {
  const { prisma, provider, bus, storage, visionPreprocessor } = dependencies;
  const timeoutMs = dependencies.timeoutMs ?? 60_000;

  return async ({
    payload,
    logger,
    reportProgress,
  }: JobContext<typeof QUEUE_NAMES.ai>): Promise<void> => {
    const run = await prisma.aiRun.findUnique({ where: { id: payload.runId } });
    if (run === null) {
      logger.warn('Skipping AI run: record not found', { runId: payload.runId });
      return;
    }
    if (run.status === 'CANCELLED') {
      logger.info('Skipping AI run: cancelled before start', { runId: run.id });
      return;
    }
    if (run.status !== 'PENDING') {
      // Idempotency: a retried job must not produce a second answer.
      logger.info('Skipping AI run: already processed', { runId: run.id, status: run.status });
      return;
    }

    const messages = aiMessageSchema.array().parse(run.messages);

    let imageContext: AiMessage | null = null;
    if (run.documentId !== null && visionPreprocessor !== null) {
      imageContext = await describeDocumentImages({
        prisma,
        storage,
        visionPreprocessor,
        workspaceId: run.workspaceId,
        documentId: run.documentId,
        correlationId: payload.correlationId,
        logger,
      }).catch((error: unknown) => {
        logger.info('Skipping image preprocessing for this run', {
          runId: run.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    }
    const providerMessages = imageContext === null ? messages : [imageContext, ...messages];

    await prisma.aiRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    await reportProgress(5, 'Antwort wird erzeugt');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let text = '';
    let usage: AiUsage | null = null;
    let failure: { code: string; message: string } | null = null;

    try {
      for await (const event of provider.stream({
        messages: providerMessages,
        model: run.model,
        correlationId: payload.correlationId,
        signal: controller.signal,
        timeoutMs,
      })) {
        switch (event.type) {
          case 'delta': {
            text += event.text;
            await bus.publish({
              type: 'ai.run.progress',
              workspaceId: run.workspaceId,
              correlationId: payload.correlationId,
              emittedAt: new Date().toISOString(),
              payload: {
                runId: run.id,
                status: 'running',
                delta: event.text,
                sequence: event.sequence,
              },
            });
            break;
          }
          case 'usage':
            usage = event.usage;
            break;
          case 'error':
            failure = { code: event.code, message: event.message };
            break;
          case 'start':
          case 'done':
          default:
            break;
        }
      }
    } catch (error) {
      failure = {
        code: 'ai_provider_unavailable',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }

    if (failure !== null) {
      await prisma.aiRun.update({
        where: { id: run.id },
        data: {
          status: failure.code === 'ai_cancelled' ? 'CANCELLED' : 'FAILED',
          errorCode: failure.code,
          finishedAt: new Date(),
          resultText: text.length > 0 ? text : null,
        },
      });
      await bus.publish({
        type: 'ai.run.failed',
        workspaceId: run.workspaceId,
        correlationId: payload.correlationId,
        emittedAt: new Date().toISOString(),
        payload: {
          runId: run.id,
          status: failure.code === 'ai_cancelled' ? 'cancelled' : 'failed',
          errorCode: failure.code,
          reason: failure.message,
        },
      });
      logger.warn('AI run failed', { runId: run.id, code: failure.code });
      return;
    }

    await prisma.aiRun.update({
      where: { id: run.id },
      data: {
        status: 'COMPLETED',
        resultText: text,
        usage: usage === null ? Prisma.JsonNull : (usage as unknown as Prisma.InputJsonObject),
        finishedAt: new Date(),
      },
    });

    await bus.publish({
      type: 'ai.run.completed',
      workspaceId: run.workspaceId,
      correlationId: payload.correlationId,
      emittedAt: new Date().toISOString(),
      payload: { runId: run.id, status: 'completed', text, usage },
    });

    await reportProgress(100, 'Antwort fertig');
    logger.info('AI run completed', {
      runId: run.id,
      provider: run.provider,
      outputTokens: usage?.outputTokens ?? 0,
    });
  };
}
