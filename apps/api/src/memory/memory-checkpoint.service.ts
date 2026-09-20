import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  type AiProvider,
  MAX_DISTILL_NOTE_TOKENS,
  MAX_DISTILL_TRANSCRIPT_CHARS,
  MEMORY_CHECKPOINT_PROMPT,
  parseMemoryNote,
  renderDistillContext,
  transcriptTail,
} from '@exocortex/ai';
import {
  type MemoryCheckpointMessage,
  type MemoryCheckpointRequest,
  type MemoryCheckpointResponse,
  type Settings,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { AI_DEFAULT_MODEL, AI_PROVIDER, PRISMA } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

import { MemoryService } from './memory.service';
import { normaliseProject } from './memory-project';
import { memoryWorkspaceFor } from './memory-workspace';

/**
 * How long the distillation may take before the checkpoint fails.
 *
 * Shorter than the capture job's two minutes, and not because the model is
 * faster here. Nobody waits for a capture. Here an agent is holding the request
 * open in the middle of a conversation somebody is having with it, so the
 * budget is what a person will sit through before the reply, not what the
 * reverse proxy allows (`/api/` gets 300 seconds in
 * `deploy/nginx/exocortex.app.conf`). A checkpoint that cannot be written in
 * forty-five seconds is better reported as failed: the caller keeps its
 * transcript and tries again at the next compaction.
 */
const CHECKPOINT_TIMEOUT_MS = 45_000;

/**
 * Length of one message's digest, in hex characters.
 *
 * Sixty-four bits, not two hundred and fifty-six. These digests are only ever
 * compared against other digests of the same session, so the space they have to
 * stay distinct in is a few thousand messages wide, and the full hash would
 * quadruple a column that is pure bookkeeping.
 */
const MESSAGE_DIGEST_CHARS = 16;

/**
 * The checkpoint before a lossy compaction (issue #92).
 *
 * Three promises, and each one is a decision that could have gone the other
 * way.
 *
 * **It is synchronous.** `capture` queues a job and answers `accepted: true`,
 * which guarantees nothing: the model may refuse, the worker may be down, and
 * the caller has already dropped the conversation by then. A checkpoint answers
 * after the note is committed or it does not answer at all.
 *
 * **It fails loudly.** Everything `capture` reports as a reason (memory off, no
 * memory workspace, AI off) is an exception here. Hermes' `checkpoint_required`
 * reads a failure as "do not compact", so a soft refusal would quietly become
 * permission to throw the conversation away.
 *
 * **It stores no evidence.** What survives is a receipt: digests, counts, and
 * the note the model wrote. ADR-019 keeps the raw transcript out of the
 * database, and a checkpoint table would have been the largest archive in it.
 */
@Injectable()
export class MemoryCheckpointService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(AI_DEFAULT_MODEL) private readonly defaultModel: string,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly settings: SettingsService,
    private readonly memory: MemoryService,
  ) {}

  async checkpoint(input: {
    userId: string;
    request: MemoryCheckpointRequest;
    correlationId: string;
  }): Promise<MemoryCheckpointResponse> {
    const startedAt = Date.now();
    const workspaceId = await memoryWorkspaceFor(this.prisma, input.userId);
    if (workspaceId === null) {
      throw new AppError(
        'memory_unavailable',
        'This account has no memory workspace; mark one of its workspaces as the memory area',
      );
    }

    const settings = await this.settings.getForWorkspace(workspaceId);
    if (!settings['memory.enabled']) {
      throw new AppError(
        'memory_unavailable',
        'The memory area is switched off for this deployment',
      );
    }
    if (!settings['ai.enabled']) {
      throw new AppError(
        'memory_unavailable',
        'A checkpoint distils the evidence before it is dropped, and the AI is switched off',
      );
    }

    const project = normaliseProject(input.request.project);
    const sessionId = input.request.sessionId;

    // What this session has already been checkpointed with. Read before the
    // model is asked, because the cheapest distillation is the one that does
    // not happen.
    const previous = await this.prisma.memoryCheckpoint.findMany({
      where: { userId: input.userId, sessionId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, digest: true, messageDigests: true, documentId: true },
    });
    const covered = new Set(previous.flatMap((row) => row.messageDigests));

    const fresh = input.request.messages.filter((message) => !covered.has(digestMessage(message)));

    if (fresh.length === 0) {
      const latest = previous[0];
      if (latest === undefined) {
        // Only reachable when every message is empty after trimming, which no
        // schema can express: `covered` is empty, so nothing could be filtered.
        throw AppError.validation('A checkpoint needs at least one message with content');
      }
      return {
        checkpointId: latest.id,
        sessionId,
        digest: latest.digest,
        deduplicated: true,
        newMessages: 0,
        documentId: latest.documentId,
        title: null,
        url: null,
        tookMs: Date.now() - startedAt,
      };
    }

    const messageDigests = fresh.map(digestMessage);
    const digest = createHash('sha256').update(messageDigests.join('\n')).digest('hex');

    const alreadyWritten = previous.find((row) => row.digest === digest);
    if (alreadyWritten !== undefined) {
      return {
        checkpointId: alreadyWritten.id,
        sessionId,
        digest,
        deduplicated: true,
        newMessages: 0,
        documentId: alreadyWritten.documentId,
        title: null,
        url: null,
        tookMs: Date.now() - startedAt,
      };
    }

    const note = await this.distil({
      messages: fresh,
      project,
      client: input.request.client,
      hint: input.request.hint ?? null,
      settings,
      correlationId: input.correlationId,
    });

    // The note first, the receipt second. A receipt without its note would make
    // the next checkpoint skip evidence nothing ever recorded; a note without a
    // receipt only costs one repeated distillation.
    const written =
      note === null
        ? null
        : await this.memory.remember({
            userId: input.userId,
            request: {
              project,
              title: note.title,
              text: note.body,
              client: input.request.client,
              tags: ['checkpoint'],
              // One page per checkpoint: the bullet points of one compaction
              // window only make sense together, the same argument `capture`
              // makes for one page per session.
              appendToday: false,
              ...(input.request.occurredAt === undefined
                ? {}
                : { occurredAt: input.request.occurredAt }),
            },
            correlationId: input.correlationId,
          });

    const evidenceChars = fresh.reduce((total, message) => total + message.text.length, 0);
    const row = await this.prisma.memoryCheckpoint
      .create({
        data: {
          workspaceId,
          userId: input.userId,
          sessionId,
          client: input.request.client,
          projectKey: project,
          digest,
          messageDigests,
          messageCount: fresh.length,
          evidenceChars,
          documentId: written?.documentId ?? null,
        },
        select: { id: true },
      })
      .catch((error: unknown) => {
        // Two identical calls racing each other. The other one committed, so
        // the promise this endpoint makes is already kept.
        this.logger.warn('Checkpoint receipt collided with a concurrent one', {
          correlationId: input.correlationId,
          sessionId,
          reason: error instanceof Error ? error.message : String(error),
        });
        return this.prisma.memoryCheckpoint.findFirstOrThrow({
          where: { userId: input.userId, sessionId, digest },
          select: { id: true },
        });
      });

    this.logger.info('Session checkpointed before compaction', {
      correlationId: input.correlationId,
      workspaceId,
      sessionId,
      project,
      client: input.request.client,
      newMessages: fresh.length,
      evidenceChars,
      documentId: written?.documentId,
    });

    return {
      checkpointId: row.id,
      sessionId,
      digest,
      deduplicated: false,
      newMessages: fresh.length,
      documentId: written?.documentId ?? null,
      title: written?.title ?? null,
      url: written?.url ?? null,
      tookMs: Date.now() - startedAt,
    };
  }

  /**
   * Asks the model for the note, and lets a failure out.
   *
   * The one place in the memory surface that does not swallow a provider error.
   * Everywhere else the caller has gone home and a missing note is a small
   * loss; here the caller is waiting to decide whether it may forget, and an
   * error it never sees is the one outcome that loses the conversation.
   */
  private async distil(input: {
    messages: readonly MemoryCheckpointMessage[];
    project: string;
    client: string;
    hint: string | null;
    settings: Settings;
    correlationId: string;
  }): Promise<{ title: string; body: string } | null> {
    const { settings } = input;
    const model =
      settings['memory.captureModelSlug'] ??
      settings['ai.compactionModelSlug'] ??
      settings['ai.defaultModelSlug'] ??
      this.defaultModel;

    const transcript = transcriptTail(
      input.messages.map((message) => `${message.role}: ${message.text}`).join('\n\n'),
      MAX_DISTILL_TRANSCRIPT_CHARS,
    );
    const context = renderDistillContext({
      projectKey: input.project,
      client: input.client,
      hint: input.hint,
    });

    const result = await this.provider.generate({
      messages: [
        { role: 'system', content: MEMORY_CHECKPOINT_PROMPT },
        { role: 'user', content: `${context}\n\n---\n\n${transcript}` },
      ],
      model,
      maxOutputTokens: MAX_DISTILL_NOTE_TOKENS,
      temperature: 0.2,
      correlationId: input.correlationId,
      timeoutMs: CHECKPOINT_TIMEOUT_MS,
    });

    return parseMemoryNote(result.text);
  }
}

/** One message's digest: role and text, so a repeated answer is not a repeated question. */
function digestMessage(message: MemoryCheckpointMessage): string {
  return createHash('sha256')
    .update(`${message.role}\u0000${message.text}`)
    .digest('hex')
    .slice(0, MESSAGE_DIGEST_CHARS);
}
