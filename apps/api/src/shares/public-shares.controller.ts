import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { type FastifyReply } from 'fastify';

import { type PublicShareResponse, publicShareResponseSchema } from '@exocortex/contracts';

import { fileResponseHeaders } from '../attachments/file-response-headers';
import { Public } from '../auth/session.guard';
import { openApiResponseSchema } from '../common/zod';

import { PublicSharesService } from './public-shares.service';

/**
 * What a share link serves (issue #83, ADR-044).
 *
 * The only `@Public()` routes in the application that answer with somebody's
 * content, which is why they are three and not more: the page, a page below it
 * when the link covers a branch, and a file on one of them. There is no
 * search here, no tree, no workspace and no write -- an anonymous reader gets
 * what the link names and the way down from it, and nothing that would let
 * them ask a question about anything else.
 */
@ApiTags('shares')
@Controller('api/share')
export class PublicSharesController {
  constructor(private readonly shares: PublicSharesService) {}

  @Public()
  @Get(':token')
  @ApiOkResponse({ schema: openApiResponseSchema(publicShareResponseSchema) })
  async read(@Param('token') token: string): Promise<PublicShareResponse> {
    return this.shares.read(token);
  }

  @Public()
  @Get(':token/pages/:documentId')
  @ApiOkResponse({ schema: openApiResponseSchema(publicShareResponseSchema) })
  async readPage(
    @Param('token') token: string,
    @Param('documentId') documentId: string,
  ): Promise<PublicShareResponse> {
    return this.shares.read(token, documentId);
  }

  @Public()
  @Get(':token/attachments/:attachmentId')
  async attachment(
    @Param('token') token: string,
    @Param('attachmentId') attachmentId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.shares.downloadAttachment(token, attachmentId);
    void reply
      // `inline`, unlike the authenticated download: an image on a shared page
      // is meant to be rendered in it, not saved. That is safe for an SVG
      // only because of the sandboxing policy these headers carry (#177).
      .headers(
        fileResponseHeaders({
          mimeType: result.mimeType,
          byteSize: result.byteSize,
          filename: result.filename,
          disposition: 'inline',
        }),
      )
      // A link is not a cache key anybody else holds, but it is one the reader
      // holds: a revoked link must stop working, so nothing is cached shared.
      .header('cache-control', 'private, max-age=60')
      .send(result.stream);
  }
}
