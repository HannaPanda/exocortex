import { Controller, Delete, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type ConnectedAppListResponse,
  connectedAppListResponseSchema,
  type DisconnectAppResponse,
  disconnectAppResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema } from '../common/zod';

import { ConnectionsService } from './connections.service';

/**
 * The OAuth clients connected to the caller's own account. Session or token
 * auth, no admin role -- but `requiredScopeForRequest` puts these paths in the
 * `admin` scope, so an ordinary agent token cannot read or cut connections.
 */
@ApiTags('me')
@Controller('api/me/connections')
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(connectedAppListResponseSchema) })
  async list(@CurrentSession() session: VerifiedSession): Promise<ConnectedAppListResponse> {
    return this.connections.list(session.userId);
  }

  @Delete(':clientId')
  @ApiOkResponse({ schema: openApiResponseSchema(disconnectAppResponseSchema) })
  async disconnect(
    @CurrentSession() session: VerifiedSession,
    @Param('clientId') clientId: string,
  ): Promise<DisconnectAppResponse> {
    return this.connections.disconnect(session.userId, clientId);
  }
}
