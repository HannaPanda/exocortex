'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type NotificationPreferencesResponse,
  type UpdateNotificationPreferenceRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * The account-wide notification preferences (issue #105, ADR-052).
 *
 * Separate from `push-queries.ts` because the two answer different questions
 * on purpose: this one is one answer per occasion for the whole account, that
 * one is one answer per occasion per browser. They sit next to each other on
 * the settings page and share nothing else.
 */

export const notificationKeys = {
  preferences: ['notifications', 'preferences'] as const,
};

export function useNotificationPreferences(): UseQueryResult<NotificationPreferencesResponse> {
  return useQuery({
    queryKey: notificationKeys.preferences,
    queryFn: () => apiRequest<NotificationPreferencesResponse>('/api/me/notification-preferences'),
    staleTime: 30_000,
  });
}

/**
 * Sets one pair. The response is the whole list, so it is written into the
 * cache rather than invalidated: the switch the person just moved should not
 * flick back to its old position while a second request is in flight.
 */
export function useSetNotificationPreference() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: UpdateNotificationPreferenceRequest) =>
      apiRequest<NotificationPreferencesResponse>('/api/me/notification-preferences', {
        method: 'PATCH',
        body: request,
      }),
    onSuccess: (result) => {
      client.setQueryData(notificationKeys.preferences, result);
    },
  });
}
