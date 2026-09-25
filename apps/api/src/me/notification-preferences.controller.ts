import { Body, Controller, Get, Headers, Patch } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type NotificationPreferencesResponse,
  notificationPreferencesResponseSchema,
  type UpdateNotificationPreferenceRequest,
  updateNotificationPreferenceRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { type ReaderLocaleHeaders } from '../common/reader-locale';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { NotificationPreferencesService } from './notification-preferences.service';

/**
 * What this account wants to be told about, over the channels that belong to
 * the account rather than to a browser (issue #105, ADR-052).
 *
 * Under `/api/me` beside the devices, and answering only the account-wide
 * half: the device-scoped half is `GET /api/me/push/devices`, where it is one
 * row per browser. A route that merged the two would have to invent a single
 * value for something that legitimately differs between a phone and a desktop.
 */
@ApiTags('me')
@Controller('api/me/notification-preferences')
export class NotificationPreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(notificationPreferencesResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Headers() headers: ReaderLocaleHeaders,
  ): Promise<NotificationPreferencesResponse> {
    return this.preferences.list(session.userId, headers);
  }

  /**
   * Sets one pair and answers with all of them.
   *
   * `PATCH` because the body names one entry of a list rather than the list:
   * the answer for that pair is replaced whole, everything else is untouched.
   * Returning the full list is what
   * lets a client render the result without a second request, and it is how a
   * mode that was silently coerced -- back to the default, which deletes the
   * row -- becomes visible instead of being assumed.
   */
  @Patch()
  @ApiBody({ schema: openApiSchema(updateNotificationPreferenceRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(notificationPreferencesResponseSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(updateNotificationPreferenceRequestSchema))
    body: UpdateNotificationPreferenceRequest,
    @Headers() headers: ReaderLocaleHeaders,
  ): Promise<NotificationPreferencesResponse> {
    return this.preferences.update(session.userId, body, headers);
  }
}
