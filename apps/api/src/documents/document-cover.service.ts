import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canEditDocument,
  canUploadFile,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type DocumentSummary,
  type GenerateDocumentCoverResponse,
  QUEUE_NAMES,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { QueueRegistry } from '@exocortex/queue';

import { AttachmentsService } from '../attachments/attachments.service';
import { AppError } from '../common/app-error';
import { confinedMembershipWhere, currentAiRunId } from '../common/correlation';
import { PRISMA, QUEUES } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

import { type CoverPayer, resolveCoverPayer } from './cover-payer';
import { DocumentsService } from './documents.service';

/**
 * Uploading a cover image in one call.
 *
 * The image itself is an ordinary attachment — the same upload, the same
 * magic-byte check, the same access control — so this service only does the
 * three things that make it a cover: reject anything that is not an image,
 * mark the file as cover-only so maintenance may collect it once it stops
 * being one, and point the page at it.
 *
 * Setting an *existing* attachment as the cover needs none of this and goes
 * through `PATCH /api/documents/:id` like every other page property.
 */
@Injectable()
export class DocumentCoverService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    private readonly access: WorkspaceAccessService,
    private readonly attachments: AttachmentsService,
    private readonly documents: DocumentsService,
    private readonly settings: SettingsService,
  ) {}

  async uploadAndSet(input: {
    documentId: string;
    userId: string;
    filename: string;
    declaredMimeType: string | undefined;
    body: Buffer;
    correlationId: string;
  }): Promise<DocumentSummary> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));

    const uploaded = await this.attachments.upload({
      workspaceId: context.workspaceId,
      userId: input.userId,
      documentId: input.documentId,
      filename: input.filename,
      declaredMimeType: input.declaredMimeType,
      body: input.body,
      correlationId: input.correlationId,
    });

    // The upload accepts every allowed type; a cover is narrower than that. The
    // file is already stored at this point, so a wrong one is removed again
    // rather than left behind as an attachment nobody asked for.
    if (!uploaded.attachment.mimeType.startsWith('image/')) {
      await this.attachments.delete({
        attachmentId: uploaded.attachment.id,
        userId: input.userId,
        correlationId: input.correlationId,
      });
      throw AppError.validation('A cover image must be an image file');
    }

    await this.prisma.attachment.update({
      where: { id: uploaded.attachment.id },
      data: { isCover: true },
    });

    // A new image makes the old crop meaningless, so the position starts over
    // in the middle.
    return this.documents.update({
      documentId: input.documentId,
      userId: input.userId,
      request: { coverAttachmentId: uploaded.attachment.id, coverPosition: 50 },
      correlationId: input.correlationId,
    });
  }

  /**
   * Queues a cover the AI draws from a prompt.
   *
   * Answers as soon as the job is enqueued. Drawing an image is a slow external
   * call, so it belongs in the worker like every other AI run; the finished
   * picture comes back through the ordinary upload route above, and the page
   * hears about the outcome over `document.cover.generated`.
   *
   * Both gates are checked here rather than in the worker, so a request that
   * cannot succeed is refused while someone is still looking at it.
   */
  async requestGeneration(input: {
    documentId: string;
    userId: string;
    prompt: string;
    correlationId: string;
  }): Promise<GenerateDocumentCoverResponse> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));
    // The finished picture is installed through the ordinary upload above,
    // which asks more than editing does: a grant on this page alone does not
    // carry a file onto it (ADR-044, `requireRoleAnchoredAt`). Asked here, so
    // nobody pays for a picture that could never be set (issue #264).
    assertPolicy(
      canUploadFile(
        await this.access.requireRoleAnchoredAt(
          context.workspaceId,
          input.userId,
          input.documentId,
        ),
      ),
    );

    // Who pays: the page's workspace for a member, the reader's own for
    // somebody who reached the page through a share (issue #264).
    const payer = await this.coverPayer(context, input.userId);

    // The paying workspace's configuration, not the deployment's: whether
    // covers may be drawn and which model draws them are workspace-scoped
    // (ADR-023), and the workspace that pays is the one that decides.
    const settings = await this.settings.getForWorkspace(payer.workspaceId);
    if (!settings['ai.enabled'] || !settings['ai.imageGenerationEnabled']) {
      throw new AppError(
        'ai_image_unavailable',
        'Image generation is switched off for this deployment',
      );
    }
    if (settings['ai.imageModelSlug'] === null) {
      throw new AppError(
        'ai_image_unavailable',
        'No image model is configured for this deployment',
      );
    }

    await this.queues.enqueue(
      QUEUE_NAMES.documentCover,
      {
        correlationId: input.correlationId,
        documentId: input.documentId,
        workspaceId: context.workspaceId,
        // Only when it differs, so a member's job reads exactly as before.
        ...(payer.workspaceId === context.workspaceId
          ? {}
          : { billingWorkspaceId: payer.workspaceId }),
        userId: input.userId,
        prompt: input.prompt,
      },
      // One attempt: every retry is a second paid image, and the processor
      // reports its own failures rather than throwing, so a retry would only
      // ever repeat an infrastructure problem.
      { attempts: 1 },
    );

    return { status: 'pending', documentId: input.documentId };
  }

  /**
   * The workspace a cover is paid for by (issue #264). The run is read from
   * the signed service token, never from the request, so a run cannot name a
   * workspace of somebody else's to pay with.
   */
  private coverPayer(
    context: Parameters<typeof resolveCoverPayer>[0]['context'],
    userId: string,
  ): Promise<CoverPayer> {
    return resolveCoverPayer(
      { context, userId, runId: currentAiRunId() },
      {
        runWorkspace: (runId) =>
          this.prisma.aiRun.findUnique({
            where: { id: runId },
            select: { workspaceId: true, createdById: true },
          }),
        firstOwnWorkspace: async (ownerId) => {
          // The order of the reader's own list, as `listForUser` keeps it, so
          // this is the workspace the chat panel offers first on a shared page.
          const membership = await this.prisma.workspaceMember.findFirst({
            where: {
              userId: ownerId,
              workspace: { archivedAt: null, isMemory: false },
              ...confinedMembershipWhere(),
            },
            orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
            select: { workspaceId: true },
          });
          return membership?.workspaceId ?? null;
        },
      },
    );
  }
}
