import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type UpdateUserPreferencesRequest,
  updateUserPreferencesRequestSchema,
  type UserPreferences,
  userPreferencesSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { PreferencesService } from './preferences.service';

/**
 * The account's personal settings (issue #98): the interface language for
 * now. `PATCH` because a later field must not be reset by a client that only
 * knows this one; today the body has a single field and it is required, so
 * "leave it alone" cannot be confused with "never chose", which is `null`.
 */
@ApiTags('me')
@Controller('api/me/preferences')
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(userPreferencesSchema) })
  async get(@CurrentSession() session: VerifiedSession): Promise<UserPreferences> {
    return this.preferences.get(session.userId);
  }

  @Patch()
  @ApiBody({ schema: openApiSchema(updateUserPreferencesRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(userPreferencesSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(updateUserPreferencesRequestSchema)) body: UpdateUserPreferencesRequest,
  ): Promise<UserPreferences> {
    return this.preferences.update(session.userId, body);
  }
}
