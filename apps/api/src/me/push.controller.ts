import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type PushDevice,
  type PushDeviceListResponse,
  pushDeviceListResponseSchema,
  pushDeviceSchema,
  type RegisterPushDeviceRequest,
  registerPushDeviceRequestSchema,
  type SendPushRequest,
  sendPushRequestSchema,
  type SendPushResponse,
  sendPushResponseSchema,
  type UpdatePushDeviceRequest,
  updatePushDeviceRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { PushService } from './push.service';

const removedResponseSchema = z.object({ removed: z.literal(true) });
type RemovedResponse = z.infer<typeof removedResponseSchema>;

/**
 * The devices one person may be notified on (issue #30, ADR-048).
 *
 * Under `/api/me` and not under a workspace, because a notification is
 * addressed to a person: the phone in somebody's pocket is not a member of
 * anything. What a notification is *about* may well live in a workspace, and
 * that is carried in its link.
 */
const listQuerySchema = z.object({
  /**
   * The endpoint of the browser that is asking, so its own row can be marked.
   * Optional: everything else on this route works without it.
   */
  endpoint: z.string().max(2000).optional(),
});
type ListQuery = z.infer<typeof listQuerySchema>;

@ApiTags('me')
@Controller('api/me/push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('devices')
  @ApiQuery({ name: 'endpoint', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(pushDeviceListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Query(zodPipe(listQuerySchema)) query: ListQuery,
  ): Promise<PushDeviceListResponse> {
    return this.push.list(session.userId, query.endpoint);
  }

  @Post('devices')
  @ApiBody({ schema: openApiSchema(registerPushDeviceRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(pushDeviceSchema) })
  async register(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(registerPushDeviceRequestSchema)) body: RegisterPushDeviceRequest,
  ): Promise<PushDevice> {
    return this.push.register(session.userId, body);
  }

  @Patch('devices/:deviceId')
  @ApiBody({ schema: openApiSchema(updatePushDeviceRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(pushDeviceSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('deviceId') deviceId: string,
    @Body(zodPipe(updatePushDeviceRequestSchema)) body: UpdatePushDeviceRequest,
  ): Promise<PushDevice> {
    return this.push.update(session.userId, deviceId, body);
  }

  @Delete('devices/:deviceId')
  @ApiOkResponse({ schema: openApiResponseSchema(removedResponseSchema) })
  async remove(
    @CurrentSession() session: VerifiedSession,
    @Param('deviceId') deviceId: string,
  ): Promise<RemovedResponse> {
    await this.push.remove(session.userId, deviceId);
    return { removed: true };
  }

  /**
   * Notifies one's own devices.
   *
   * The same route serves the settings page's test button and an agent saying
   * something on purpose, because they are the same act: a message from
   * somebody's own account to somebody's own phone.
   */
  @Post('send')
  @ApiBody({ schema: openApiSchema(sendPushRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(sendPushResponseSchema) })
  async send(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(sendPushRequestSchema)) body: SendPushRequest,
  ): Promise<SendPushResponse> {
    return this.push.send(session.userId, body);
  }
}
