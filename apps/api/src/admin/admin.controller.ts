import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AdminOverviewResponse,
  adminOverviewResponseSchema,
  type AdminUser,
  type AdminUserListResponse,
  adminUserListResponseSchema,
  adminUserSchema,
  type SettingsResponse,
  settingsResponseSchema,
  type UpdateSettingsRequest,
  updateSettingsRequestSchema,
  type UpdateUserRoleRequest,
  updateUserRoleRequestSchema,
} from '@exocortex/contracts';

import { AdminOnly } from '../auth/admin.guard';
import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { AdminService } from './admin.service';

/**
 * Deployment-wide administration. `@AdminOnly()` on the class so no future
 * route on this controller can accidentally be forgotten (the guard reads
 * `getAllAndOverride`, so a class-level decorator covers every method).
 */
@ApiTags('admin')
@AdminOnly()
@Controller('api/admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  @ApiOkResponse({ schema: openApiResponseSchema(adminOverviewResponseSchema) })
  async overview(): Promise<AdminOverviewResponse> {
    return this.admin.overview();
  }

  @Get('settings')
  @ApiOkResponse({ schema: openApiResponseSchema(settingsResponseSchema) })
  async getSettings(): Promise<SettingsResponse> {
    return { settings: await this.admin.getSettings() };
  }

  @Patch('settings')
  @ApiBody({ schema: openApiSchema(updateSettingsRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(settingsResponseSchema) })
  async updateSettings(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(updateSettingsRequestSchema)) body: UpdateSettingsRequest,
  ): Promise<SettingsResponse> {
    return { settings: await this.admin.updateSettings(body, session.userId) };
  }

  @Get('users')
  @ApiOkResponse({ schema: openApiResponseSchema(adminUserListResponseSchema) })
  async listUsers(): Promise<AdminUserListResponse> {
    return this.admin.listUsers();
  }

  @Patch('users/:userId')
  @ApiBody({ schema: openApiSchema(updateUserRoleRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(adminUserSchema) })
  async updateUserRole(
    @CurrentSession() session: VerifiedSession,
    @Param('userId') userId: string,
    @Body(zodPipe(updateUserRoleRequestSchema)) body: UpdateUserRoleRequest,
  ): Promise<AdminUser> {
    return this.admin.updateUserRole(userId, body.role, session.userId);
  }
}
