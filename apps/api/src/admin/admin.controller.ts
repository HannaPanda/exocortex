import { Body, Controller, Delete, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AdminOverviewResponse,
  adminOverviewResponseSchema,
  type AdminUser,
  type AdminUserListResponse,
  adminUserListResponseSchema,
  adminUserSchema,
  type AiUsageQuery,
  aiUsageQuerySchema,
  type AiUsageResponse,
  aiUsageResponseSchema,
  type DeleteUserResponse,
  deleteUserResponseSchema,
  type SettingsResponse,
  settingsResponseSchema,
  type UpdateSettingsRequest,
  updateSettingsRequestSchema,
  type UpdateUserRoleRequest,
  updateUserRoleRequestSchema,
  type UpdateUserStatusRequest,
  updateUserStatusRequestSchema,
} from '@exocortex/contracts';

import { AdminOnly } from '../auth/admin.guard';
import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { AdminService } from './admin.service';
import { AiUsageService } from './ai-usage.service';

/**
 * Deployment-wide administration. `@AdminOnly()` on the class so no future
 * route on this controller can accidentally be forgotten (the guard reads
 * `getAllAndOverride`, so a class-level decorator covers every method).
 */
@ApiTags('admin')
@AdminOnly()
@Controller('api/admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly aiUsage: AiUsageService,
  ) {}

  @Get('overview')
  @ApiOkResponse({ schema: openApiResponseSchema(adminOverviewResponseSchema) })
  async overview(): Promise<AdminOverviewResponse> {
    return this.admin.overview();
  }

  /**
   * The usage view's one endpoint (issue #10).
   *
   * Deliberately not folded into `overview`: that one is a handful of counters
   * every admin page load asks for, this one aggregates a time range and is
   * asked for only when somebody opens the page.
   */
  @Get('ai-usage')
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiOkResponse({ schema: openApiResponseSchema(aiUsageResponseSchema) })
  async aiUsageReport(
    @Query(zodPipe(aiUsageQuerySchema)) query: AiUsageQuery,
  ): Promise<AiUsageResponse> {
    return this.aiUsage.usage(query);
  }

  @Get('settings')
  @ApiOkResponse({ schema: openApiResponseSchema(settingsResponseSchema) })
  async getSettings(): Promise<SettingsResponse> {
    return this.admin.getSettings();
  }

  @Patch('settings')
  @ApiBody({ schema: openApiSchema(updateSettingsRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(settingsResponseSchema) })
  async updateSettings(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(updateSettingsRequestSchema)) body: UpdateSettingsRequest,
  ): Promise<SettingsResponse> {
    return this.admin.updateSettings(body, session.userId);
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

  /**
   * Switching an account off is its own route rather than a field on the one
   * above: the two do different things (one changes what somebody may do, the
   * other whether they may do anything), and a single PATCH that could do both
   * makes "disable this person" and "demote this person" one fat-fingered
   * keystroke apart.
   */
  @Patch('users/:userId/status')
  @ApiBody({ schema: openApiSchema(updateUserStatusRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(adminUserSchema) })
  async updateUserStatus(
    @CurrentSession() session: VerifiedSession,
    @Param('userId') userId: string,
    @Body(zodPipe(updateUserStatusRequestSchema)) body: UpdateUserStatusRequest,
  ): Promise<AdminUser> {
    return this.admin.setUserDisabled({
      userId,
      disabled: body.disabled,
      actorId: session.userId,
    });
  }

  @Delete('users/:userId')
  @ApiOkResponse({ schema: openApiResponseSchema(deleteUserResponseSchema) })
  async deleteUser(
    @CurrentSession() session: VerifiedSession,
    @Param('userId') userId: string,
  ): Promise<DeleteUserResponse> {
    await this.admin.deleteUser({ userId, actorId: session.userId });
    return { deleted: true };
  }
}
