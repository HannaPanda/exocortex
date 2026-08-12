import { Body, Controller, Delete, Get, Param, Patch } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AdminOverviewResponse,
  adminOverviewResponseSchema,
  type AdminUser,
  type AdminUserListResponse,
  adminUserListResponseSchema,
  adminUserSchema,
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
