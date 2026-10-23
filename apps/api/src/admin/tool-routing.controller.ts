import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type ToolRoutingStatus,
  toolRoutingStatusSchema,
  type UpdateToolRoutingRequest,
  updateToolRoutingRequestSchema,
} from '@exocortex/contracts';

import { AdminOnly } from '../auth/admin.guard';
import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { ToolRoutingService } from './tool-routing.service';

/**
 * Whether Jev chooses the built-in AI's tools (issue #206, ADR-089), for an
 * administrator in the browser or through `exo_tool_routing_set`.
 *
 * Its own pair of routes because `/api/admin/settings` is deliberately out of
 * an agent's reach, and this one switch is the emergency stop for a model
 * call every run makes: it has to work without a deploy and without a
 * browser. It changes which tools a run is told about, never which it may
 * call (ADR-060), which is why it may be reachable where the settings are not.
 */
@ApiTags('admin')
@AdminOnly()
@Controller('api/admin/tool-routing')
export class ToolRoutingController {
  constructor(private readonly routing: ToolRoutingService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(toolRoutingStatusSchema) })
  async status(): Promise<ToolRoutingStatus> {
    return this.routing.status();
  }

  @Patch()
  @ApiBody({ schema: openApiSchema(updateToolRoutingRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(toolRoutingStatusSchema) })
  async set(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(updateToolRoutingRequestSchema)) body: UpdateToolRoutingRequest,
  ): Promise<ToolRoutingStatus> {
    return this.routing.set(body.enabled, session.userId);
  }
}
