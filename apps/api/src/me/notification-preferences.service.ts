import { Inject, Injectable } from '@nestjs/common';

import {
  type NotificationPreferencesResponse,
  type UpdateNotificationPreferenceRequest,
} from '@exocortex/contracts';
import {
  listNotificationPreferences,
  notificationPreferenceRefusal,
  type PrismaClient,
  setNotificationPreference,
} from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform-tokens';

/**
 * The account-wide half of "tell me about this" (issue #105, ADR-052).
 *
 * Thin on purpose. What a pair means, which modes it allows and what holds
 * while nobody has decided are all in `NOTIFICATION_CATALOG` and the resolver
 * beside it in `@exocortex/database`, because the worker has to reach the same
 * answers while dispatching the outbox and a second copy here would be a
 * second policy.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(userId: string): Promise<NotificationPreferencesResponse> {
    return { preferences: await listNotificationPreferences(this.prisma, userId) };
  }

  async update(
    userId: string,
    body: UpdateNotificationPreferenceRequest,
  ): Promise<NotificationPreferencesResponse> {
    const refusal = notificationPreferenceRefusal(body.kind, body.channel, body.mode);
    if (refusal === 'unsupported_pair') {
      throw AppError.validation(
        `${body.kind} is not delivered over ${body.channel} in this deployment`,
      );
    }
    if (refusal === 'device_scoped') {
      // Not an oversight and not a missing feature: push preferences are a
      // column on the device (ADR-048). Saying so is more useful than a
      // generic refusal, because the caller has somewhere else to go.
      throw AppError.validation(
        `${body.channel} preferences are stored per device; use /api/me/push/devices`,
      );
    }
    if (refusal === 'unsupported_mode') {
      throw AppError.validation(
        `${body.mode} is not one of the delivery modes for ${body.kind} over ${body.channel}`,
      );
    }

    await setNotificationPreference(this.prisma, userId, body.kind, body.channel, body.mode);
    return this.list(userId);
  }
}
