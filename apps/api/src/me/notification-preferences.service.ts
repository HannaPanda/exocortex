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
import { serverTranslator } from '@exocortex/i18n/catalog';

import { AppError } from '../common/app-error';
import { readerLocale, type ReaderLocaleHeaders } from '../common/reader-locale';
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

  /**
   * Every account-wide pair, named in the requester's language. The words come
   * from `account.notifications.kinds`, the same entries the settings page
   * reads, so an agent and the browser call an occasion the same thing.
   */
  async list(
    userId: string,
    headers: ReaderLocaleHeaders,
  ): Promise<NotificationPreferencesResponse> {
    const [locale, stored] = await Promise.all([
      readerLocale(this.prisma, userId, headers),
      listNotificationPreferences(this.prisma, userId),
    ]);
    const t = serverTranslator(locale, 'account');
    return {
      preferences: stored.map((preference) => ({
        ...preference,
        label: t(`notifications.kinds.${preference.kind}.label`),
        description: t(`notifications.kinds.${preference.kind}.description`),
      })),
    };
  }

  async update(
    userId: string,
    body: UpdateNotificationPreferenceRequest,
    headers: ReaderLocaleHeaders,
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
    return this.list(userId, headers);
  }
}
