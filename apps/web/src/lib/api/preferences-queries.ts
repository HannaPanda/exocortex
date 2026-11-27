'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type ChatScrollMode,
  DEFAULT_CHAT_SCROLL_MODE,
  DEFAULT_OUTLINE_DODGE,
  DEFAULT_OUTLINE_HOVER_EXPAND,
  DEFAULT_OUTLINE_PINNED_MODE,
  DEFAULT_OUTLINE_TRANSPARENCY,
  type OutlinePinnedMode,
  type OutlineTransparency,
  type UpdateUserPreferencesRequest,
  type UserPreferences,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';

/** The account's personal settings: language (#98), chat scrolling (#282), the outline (#283). */
export const preferenceKeys = {
  preferences: ['me', 'preferences'] as const,
};

export function useUserPreferences(): UseQueryResult<UserPreferences> {
  return useQuery({
    queryKey: preferenceKeys.preferences,
    queryFn: () => apiRequest<UserPreferences>('/api/me/preferences'),
    staleTime: 30_000,
  });
}

/**
 * Saves the choice and refreshes the session, which carries the locale too:
 * `LocaleSync` reads it there, on every tab of this account.
 */
export function useSetUserPreferences() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: UpdateUserPreferencesRequest) =>
      apiRequest<UserPreferences>('/api/me/preferences', { method: 'PATCH', body: request }),
    onSuccess: (result) => {
      client.setQueryData(preferenceKeys.preferences, result);
      void client.invalidateQueries({ queryKey: queryKeys.session });
    },
  });
}

export interface ChatScrollPreference {
  mode: ChatScrollMode;
  change: (mode: ChatScrollMode, options?: { onError?: () => void }) => void;
  pending: boolean;
}

/**
 * How the AI chat scrolls while an answer arrives (issue #282), from the
 * panel's menu, the palette and the settings page alike.
 *
 * The choice shows at once and is taken back if saving fails, so a press in
 * the panel changes the transcript before the round trip is over. Nothing
 * else in the session depends on it, so the session is left alone.
 */
export function useChatScrollPreference(): ChatScrollPreference {
  const client = useQueryClient();
  const query = useUserPreferences();
  const mutation = useMutation({
    mutationFn: (chatScroll: ChatScrollMode) =>
      apiRequest<UserPreferences>('/api/me/preferences', {
        method: 'PATCH',
        body: { chatScroll } satisfies UpdateUserPreferencesRequest,
      }),
    onMutate: async (chatScroll) => {
      await client.cancelQueries({ queryKey: preferenceKeys.preferences });
      const before = client.getQueryData<UserPreferences>(preferenceKeys.preferences);
      if (before !== undefined) {
        client.setQueryData<UserPreferences>(preferenceKeys.preferences, {
          ...before,
          chatScroll,
        });
      }
      return { before };
    },
    onError: (_error, _chatScroll, context) => {
      if (context?.before !== undefined) {
        client.setQueryData(preferenceKeys.preferences, context.before);
      }
    },
    onSuccess: (result) => {
      client.setQueryData(preferenceKeys.preferences, result);
    },
  });
  return {
    mode: query.data?.chatScroll ?? DEFAULT_CHAT_SCROLL_MODE,
    change: (mode, options) => mutation.mutate(mode, { onError: options?.onError }),
    pending: mutation.isPending,
  };
}

/** What `useOutlinePreferences` can change; every field one of `UserPreferences`. */
export type OutlinePreferenceChange = Partial<
  Pick<
    UserPreferences,
    'outlinePinned' | 'outlineTransparency' | 'outlineDodge' | 'outlineHoverExpand'
  >
>;

export interface OutlinePreferences {
  pinned: OutlinePinnedMode;
  transparency: OutlineTransparency;
  /** Whether an overlaid list steps aside for the line being written on. */
  dodge: boolean;
  /** Whether the scale opens its list when the pointer rests on it. */
  hoverExpand: boolean;
  change: (change: OutlinePreferenceChange, options?: { onError?: () => void }) => void;
  pending: boolean;
}

/**
 * How a pinned page outline behaves (issue #283), read by the outline itself
 * and changed from the settings page and the palette.
 *
 * Optimistic like the chat's scrolling: the outline moves the moment the
 * choice is made and moves back if saving fails. Until the preferences have
 * loaded, the defaults are today's behaviour, so a slow request never shows
 * the text jumping under a list that then moves aside.
 */
export function useOutlinePreferences(): OutlinePreferences {
  const client = useQueryClient();
  const query = useUserPreferences();
  const mutation = useMutation({
    mutationFn: (change: OutlinePreferenceChange) =>
      apiRequest<UserPreferences>('/api/me/preferences', {
        method: 'PATCH',
        body: change satisfies UpdateUserPreferencesRequest,
      }),
    onMutate: async (change) => {
      await client.cancelQueries({ queryKey: preferenceKeys.preferences });
      const before = client.getQueryData<UserPreferences>(preferenceKeys.preferences);
      if (before !== undefined) {
        client.setQueryData<UserPreferences>(preferenceKeys.preferences, {
          ...before,
          ...change,
        });
      }
      return { before };
    },
    onError: (_error, _change, context) => {
      if (context?.before !== undefined) {
        client.setQueryData(preferenceKeys.preferences, context.before);
      }
    },
    onSuccess: (result) => {
      client.setQueryData(preferenceKeys.preferences, result);
    },
  });
  return {
    pinned: query.data?.outlinePinned ?? DEFAULT_OUTLINE_PINNED_MODE,
    transparency: query.data?.outlineTransparency ?? DEFAULT_OUTLINE_TRANSPARENCY,
    dodge: query.data?.outlineDodge ?? DEFAULT_OUTLINE_DODGE,
    hoverExpand: query.data?.outlineHoverExpand ?? DEFAULT_OUTLINE_HOVER_EXPAND,
    change: (change, options) => mutation.mutate(change, { onError: options?.onError }),
    pending: mutation.isPending,
  };
}
