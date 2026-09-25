'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { type UpdateUserPreferencesRequest, type UserPreferences } from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';

/** The account's personal settings (issue #98): the interface language. */
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
