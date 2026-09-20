import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { type FastifyReply, type FastifyRequest } from 'fastify';

import { type VerifiedSession } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type AttachmentTextCorrectionInput,
  attachmentTextCorrectionInputSchema,
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
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

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

  /**
   * `?variant=preview` asks for the downscaled copy of an image and falls back
   * to the original when there is none, so a renderer can ask for it
   * unconditionally and never has to know whether one was made.
   */
  @Get('attachments/:attachmentId/download')
  async download(
    @CurrentSession() session: VerifiedSession,
    @Param('attachmentId') attachmentId: string,
    @Query('variant') variant: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.attachments.download(
      attachmentId,
      session.userId,
      variant === 'preview' ? 'preview' : 'original',
    );
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

  /**
   * Forces a fresh extraction even when the attachment is already `ready`
   * (issue #2). `GET .../text` is deliberately idempotent and never does
   * this; a person unhappy with a *successful but wrong* extraction has to
   * ask for this explicitly.
   */
  @Post('attachments/:attachmentId/text/reextract')
  @ApiOkResponse({ schema: openApiResponseSchema(attachmentTextResponseSchema) })
  async reextractText(
    @CurrentSession() session: VerifiedSession,
    @Param('attachmentId') attachmentId: string,
  ): Promise<AttachmentTextResponse> {
    return this.attachments.forceReextract(attachmentId, session.userId, currentCorrelationId());
  }

  /**
   * Writes, or with `text: null` clears, a human correction of the extracted
   * text (issue #2). The only write path `extractedText` has ever had.
   */
  @Patch('attachments/:attachmentId/text')
  @ApiBody({ schema: openApiSchema(attachmentTextCorrectionInputSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(attachmentTextResponseSchema) })
  async correctText(
    @CurrentSession() session: VerifiedSession,
    @Param('attachmentId') attachmentId: string,
    @Body(zodPipe(attachmentTextCorrectionInputSchema)) body: AttachmentTextCorrectionInput,
  ): Promise<AttachmentTextResponse> {
    return this.attachments.correctText(
      attachmentId,
      session.userId,
      body.text,
      currentCorrelationId(),
    );
  }
}
