import { Inject, Injectable } from '@nestjs/common';

import {
  isLocale,
  type UpdateUserPreferencesRequest,
  type UserPreferences,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform-tokens';

/**
 * The person's own settings that follow them from device to device (issue
 * #98). Today that is the interface language; the row it lives on is the
 * account itself, because a preference that belongs to the person has no
 * better owner.
 */
@Injectable()
export class PreferencesService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async get(userId: string): Promise<UserPreferences> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { locale: true },
    });
    if (user === null)
      throw AppError.unauthenticated('Session references a user that no longer exists');
    return { locale: isLocale(user.locale) ? user.locale : null };
  }

  async update(userId: string, body: UpdateUserPreferencesRequest): Promise<UserPreferences> {
    await this.prisma.user.update({ where: { id: userId }, data: { locale: body.locale } });
    return this.get(userId);
  }
}
