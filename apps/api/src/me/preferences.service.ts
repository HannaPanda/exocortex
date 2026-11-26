import { Inject, Injectable } from '@nestjs/common';

import {
  type ChatScrollMode,
  isLocale,
  type UpdateUserPreferencesRequest,
  type UserPreferences,
} from '@exocortex/contracts';
import {
  type ChatScrollMode as StoredChatScrollMode,
  type PrismaClient,
} from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform-tokens';

/** The wire spelling of the stored enum, and back (issue #282). */
const CHAT_SCROLL_FROM_ROW: Record<StoredChatScrollMode, ChatScrollMode> = {
  FOLLOW: 'follow',
  ANSWER_START: 'answerStart',
};
const CHAT_SCROLL_TO_ROW: Record<ChatScrollMode, StoredChatScrollMode> = {
  follow: 'FOLLOW',
  answerStart: 'ANSWER_START',
};

/**
 * The person's own settings that follow them from device to device: the
 * interface language (issue #98) and how the AI chat scrolls while an answer
 * arrives (issue #282). The row they live on is the account itself, because
 * a preference that belongs to the person has no better owner.
 */
@Injectable()
export class PreferencesService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async get(userId: string): Promise<UserPreferences> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { locale: true, chatScroll: true },
    });
    if (user === null)
      throw AppError.unauthenticated('Session references a user that no longer exists');
    return {
      locale: isLocale(user.locale) ? user.locale : null,
      chatScroll: CHAT_SCROLL_FROM_ROW[user.chatScroll],
    };
  }

  /** Only what the request names changes; a field left out stays as it is. */
  async update(userId: string, body: UpdateUserPreferencesRequest): Promise<UserPreferences> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(body.locale === undefined ? {} : { locale: body.locale }),
        ...(body.chatScroll === undefined
          ? {}
          : { chatScroll: CHAT_SCROLL_TO_ROW[body.chatScroll] }),
      },
    });
    return this.get(userId);
  }
}
