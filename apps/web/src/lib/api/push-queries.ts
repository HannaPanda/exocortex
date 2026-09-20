'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type PushDevice,
  type PushDeviceListResponse,
  type PushNotificationKind,
  type SendPushRequest,
  type SendPushResponse,
  type UpdatePushDeviceRequest,
} from '@exocortex/contracts';

import { readExistingSubscription } from '../push';

import { apiRequest } from './client';

/**
 * The devices this account may be notified on (issue #30, ADR-048).
 *
 * Its own file rather than a corner of the settings queries, because half of
 * what it does is not an API call at all: subscribing is a conversation with
 * the browser -- permission, service worker, push manager -- and only the
 * result of that conversation is posted here.
 */

export const pushKeys = {
  devices: (endpoint: string | null) => ['push', 'devices', endpoint ?? ''] as const,
  /** What this browser itself holds. Not an API call; see `useBrowserSubscription`. */
  browserSubscription: ['push', 'browser-subscription'] as const,
};

/**
 * The subscription this browser already has, as a query rather than an effect.
 *
 * It is asked once and then cached for the session: a subscription changes
 * only when this page changes it, and both of those invalidate the key. Using
 * the query cache here also keeps the device list from being fetched before
 * the answer is in, which is what stops a row rendering first as somebody
 * else's device and a moment later as this one.
 */
export function useBrowserSubscription(
  enabled: boolean,
): UseQueryResult<{ endpoint: string } | null> {
  return useQuery({
    queryKey: pushKeys.browserSubscription,
    queryFn: async () => (await readExistingSubscription()) ?? null,
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

export function usePushDevices(
  endpoint: string | null,
  enabled: boolean,
): UseQueryResult<PushDeviceListResponse> {
  return useQuery({
    queryKey: pushKeys.devices(endpoint),
    queryFn: () =>
      apiRequest<PushDeviceListResponse>(
        `/api/me/push/devices${endpoint === null ? '' : `?endpoint=${encodeURIComponent(endpoint)}`}`,
      ),
    // Waits for the browser to have looked up its own subscription, so the
    // list is never rendered once without a current device and again with one.
    enabled,
    staleTime: 30_000,
  });
}

export function useUpdatePushDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { deviceId: string; request: UpdatePushDeviceRequest }) =>
      apiRequest<PushDevice>(`/api/me/push/devices/${input.deviceId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    // Only the list: renaming a device or changing what it accepts does not
    // touch the subscription the browser holds.
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['push', 'devices'] });
    },
  });
}

export function useRemovePushDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) =>
      apiRequest<{ removed: true }>(`/api/me/push/devices/${deviceId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['push', 'devices'] });
      void client.invalidateQueries({ queryKey: pushKeys.browserSubscription });
    },
  });
}

export function useSendTestPush() {
  return useMutation({
    mutationFn: (request: SendPushRequest) =>
      apiRequest<SendPushResponse>('/api/me/push/send', { method: 'POST', body: request }),
  });
}

/** Registers a subscription this browser just made, or refreshes an old one. */
export function useRegisterPushDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
      label: string;
      kinds?: PushNotificationKind[];
    }) => apiRequest<PushDevice>('/api/me/push/devices', { method: 'POST', body: input }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['push', 'devices'] });
      void client.invalidateQueries({ queryKey: pushKeys.browserSubscription });
    },
  });
}
