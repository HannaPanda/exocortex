import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiConsumes, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { type FastifyReply, type FastifyRequest } from 'fastify';

import { type VerifiedSession } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type AttachmentTextInfoResponse,
  attachmentTextInfoResponseSchema,
  type AttachmentTextResponse,
  attachmentTextResponseSchema,
  type UploadAttachmentResponse,
  uploadAttachmentResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { API_ENV } from '../common/logger.provider';
import { readUploadedFile } from '../common/multipart';
import { openApiResponseSchema } from '../common/zod';

import { AttachmentsService } from './attachments.service';

/**
 * Multipart uploads are read through `@fastify/multipart`, which enforces the
 * size limit while streaming, so an oversized file never reaches memory in full.
 */
@ApiTags('attachments')
@Controller('api')
export class AttachmentsController {
  constructor(
    private readonly attachments: AttachmentsService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  @Post('workspaces/:workspaceId/attachments')
  @ApiConsumes('multipart/form-data')
  @ApiOkResponse({ schema: openApiResponseSchema(uploadAttachmentResponseSchema) })
  async upload(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Req() request: FastifyRequest,
  ): Promise<UploadAttachmentResponse> {
    const file = await readUploadedFile(request, this.env.MAX_UPLOAD_BYTES);
    const documentId = file.fields.documentId ?? '';

    return this.attachments.upload({
      workspaceId,
      userId: session.userId,
      documentId: documentId.length > 0 ? documentId : null,
      filename: file.filename,
      declaredMimeType: file.declaredMimeType,
      body: file.body,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('attachments/:attachmentId/download')
  async download(
    @CurrentSession() session: VerifiedSession,
    @Param('attachmentId') attachmentId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.attachments.download(attachmentId, session.userId);
    void reply
      .header('content-type', result.mimeType)
      .header('content-length', String(result.byteSize))
      .header(
        'content-disposition',
        `attachment; filename="${result.filename.replace(/[^\x20-\x7e]/g, '_')}"`,
      )
      .send(result.stream);
  }

  @Delete('attachments/:attachmentId')
  @HttpCode(204)
  async remove(
    @CurrentSession() session: VerifiedSession,
    @Param('attachmentId') attachmentId: string,
  ): Promise<void> {
    await this.attachments.delete({
      attachmentId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('attachments/:attachmentId/text')
  @ApiOkResponse({ schema: openApiResponseSchema(attachmentTextResponseSchema) })
  async text(
    @CurrentSession() session: VerifiedSession,
    @Param('attachmentId') attachmentId: string,
  ): Promise<AttachmentTextResponse> {
    return this.attachments.getText(attachmentId, session.userId, currentCorrelationId());
  }

  /**
   * Everything the route above returns except the text, and without starting an
   * extraction. This is the read a rendered PDF block performs.
   */
  @Get('attachments/:attachmentId/text/info')
  @ApiOkResponse({ schema: openApiResponseSchema(attachmentTextInfoResponseSchema) })
  async textInfo(
    @CurrentSession() session: VerifiedSession,
    @Param('attachmentId') attachmentId: string,
  ): Promise<AttachmentTextInfoResponse> {
    return this.attachments.getTextInfo(attachmentId, session.userId);
  }
}
