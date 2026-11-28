import { Inject, Injectable } from '@nestjs/common';

import {
  type ChatScrollMode,
  isLocale,
  type OutlinePinnedMode,
  type OutlineTransparency,
  type TimeFormat,
  type UpdateUserPreferencesRequest,
  type UserPreferences,
} from '@exocortex/contracts';
import {
  type ChatScrollMode as StoredChatScrollMode,
  type OutlinePinnedMode as StoredOutlinePinnedMode,
  type OutlineTransparency as StoredOutlineTransparency,
  type PrismaClient,
  type TimeFormat as StoredTimeFormat,
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

/** The same for the pinned outline (issue #283). */
const OUTLINE_PINNED_FROM_ROW: Record<StoredOutlinePinnedMode, OutlinePinnedMode> = {
  COLUMN: 'column',
  OVERLAY: 'overlay',
};
const OUTLINE_PINNED_TO_ROW: Record<OutlinePinnedMode, StoredOutlinePinnedMode> = {
  column: 'COLUMN',
  overlay: 'OVERLAY',
};
const OUTLINE_TRANSPARENCY_FROM_ROW: Record<StoredOutlineTransparency, OutlineTransparency> = {
  NONE: 'none',
  LIGHT: 'light',
  STRONG: 'strong',
};
const OUTLINE_TRANSPARENCY_TO_ROW: Record<OutlineTransparency, StoredOutlineTransparency> = {
  none: 'NONE',
  light: 'LIGHT',
  strong: 'STRONG',
};

/** The clock a time of day is written on (issue #255). */
const TIME_FORMAT_FROM_ROW: Record<StoredTimeFormat, TimeFormat> = {
  AUTO: 'auto',
  H24: '24h',
  H12: '12h',
};
const TIME_FORMAT_TO_ROW: Record<TimeFormat, StoredTimeFormat> = {
  auto: 'AUTO',
  '24h': 'H24',
  '12h': 'H12',
};

/**
 * The person's own settings that follow them from device to device: the
 * interface language (issue #98), the clock a time is written on (issue
 * #255), how the AI chat scrolls while an answer arrives (issue #282), how a
 * pinned page outline behaves (issue #283) and whether the editor marks the
 * block the caret is in (issue #238). The row they live on is the account
 * itself, because a preference that belongs to the person has no better owner.
 */
@Injectable()
export class PreferencesService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async get(userId: string): Promise<UserPreferences> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        locale: true,
        chatScroll: true,
        outlinePinned: true,
        outlineTransparency: true,
        outlineDodge: true,
        outlineHoverExpand: true,
        activeBlockMarker: true,
        timeFormat: true,
      },
    });
    if (user === null)
      throw AppError.unauthenticated('Session references a user that no longer exists');
    return {
      locale: isLocale(user.locale) ? user.locale : null,
      chatScroll: CHAT_SCROLL_FROM_ROW[user.chatScroll],
      outlinePinned: OUTLINE_PINNED_FROM_ROW[user.outlinePinned],
      outlineTransparency: OUTLINE_TRANSPARENCY_FROM_ROW[user.outlineTransparency],
      outlineDodge: user.outlineDodge,
      outlineHoverExpand: user.outlineHoverExpand,
      activeBlockMarker: user.activeBlockMarker,
      timeFormat: TIME_FORMAT_FROM_ROW[user.timeFormat],
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
        ...(body.outlinePinned === undefined
          ? {}
          : { outlinePinned: OUTLINE_PINNED_TO_ROW[body.outlinePinned] }),
        ...(body.outlineTransparency === undefined
          ? {}
          : { outlineTransparency: OUTLINE_TRANSPARENCY_TO_ROW[body.outlineTransparency] }),
        ...(body.outlineDodge === undefined ? {} : { outlineDodge: body.outlineDodge }),
        ...(body.outlineHoverExpand === undefined
          ? {}
          : { outlineHoverExpand: body.outlineHoverExpand }),
        ...(body.activeBlockMarker === undefined
          ? {}
          : { activeBlockMarker: body.activeBlockMarker }),
        ...(body.timeFormat === undefined
          ? {}
          : { timeFormat: TIME_FORMAT_TO_ROW[body.timeFormat] }),
      },
    });
    return this.get(userId);
  }
}
