import { z } from 'zod';

import type { NotificationKind } from './notifications';
import { idSchema } from './primitives';

/**
 * Push notifications for the installed app (issue #30, ADR-048).
 *
 * The shapes here answer three different questions and it is worth keeping
 * them apart: what a browser hands over when it subscribes, what the person
 * sees about their own devices afterwards, and what actually travels to a
 * device. Only the first carries the encryption keys, and they never come back
 * out -- a device list that returned them would be a list of working addresses
 * for making somebody's phone beep.
 */

/**
 * The occasions a device can be told about.
 *
 * These are `NotificationKind`s (issue #105) rather than a vocabulary of their
 * own: an occasion is one thing whichever transport carries it, and two lists
 * that had to be mapped onto each other would drift the first time somebody
 * added to one. The subset is written out rather than filtered out of
 * `NOTIFICATION_CATALOG` so that it is a literal type; `notifications.test.ts`
 * is what keeps it equal to the catalogue's push-capable kinds.
 */
export const pushNotificationKinds = [
  'COMMENT',
  'CALENDAR',
  'AGENT',
] as const satisfies readonly NotificationKind[];
export const pushNotificationKindSchema = z.enum(pushNotificationKinds);
export type PushNotificationKind = z.infer<typeof pushNotificationKindSchema>;

/** The default for a device that has just said yes: everything. */
export const DEFAULT_PUSH_KINDS: readonly PushNotificationKind[] = pushNotificationKinds;

export const pushDeviceLabelSchema = z.string().trim().min(1).max(120);

export const registerPushDeviceRequestSchema = z.object({
  /**
   * The address the browser's push service minted. Always https, and long:
   * FCM and Mozilla both put a long opaque identifier in the path.
   */
  endpoint: z.string().url().max(2000).startsWith('https://'),
  keys: z.object({
    /** P-256 public key, uncompressed point, base64url (87 characters). */
    p256dh: z.string().min(1).max(200),
    /** Authentication secret, 16 bytes, base64url (22 characters). */
    auth: z.string().min(1).max(64),
  }),
  /** Proposed by the browser from its user agent; editable afterwards. */
  label: pushDeviceLabelSchema,
  /** Left out on a re-registration, which must not silently re-enable a kind. */
  kinds: z.array(pushNotificationKindSchema).max(pushNotificationKinds.length).optional(),
});
export type RegisterPushDeviceRequest = z.infer<typeof registerPushDeviceRequestSchema>;

export const updatePushDeviceRequestSchema = z
  .object({
    label: pushDeviceLabelSchema.optional(),
    kinds: z.array(pushNotificationKindSchema).max(pushNotificationKinds.length).optional(),
  })
  .refine((value) => value.label !== undefined || value.kinds !== undefined, {
    message: 'Nothing to change',
  });
export type UpdatePushDeviceRequest = z.infer<typeof updatePushDeviceRequestSchema>;

export const pushDeviceSchema = z.object({
  id: idSchema,
  label: z.string(),
  kinds: z.array(pushNotificationKindSchema),
  /**
   * The push service's host, so a person can tell two browsers apart when the
   * labels are unhelpful. The path is deliberately left off: it is the part
   * that addresses the device.
   */
  service: z.string(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  lastDeliveredAt: z.iso.datetime().nullable(),
  /** Consecutive failures. Anything above zero is worth showing. */
  failureCount: z.number().int().nonnegative(),
  /** Whether this row is the device asking. Registration returns it set. */
  current: z.boolean(),
});
export type PushDevice = z.infer<typeof pushDeviceSchema>;

export const pushDeviceListResponseSchema = z.object({
  /**
   * Whether this deployment can send at all, which is whether a VAPID key pair
   * exists. False makes every other field moot and is what the settings page
   * explains instead of offering a button that cannot work.
   */
  configured: z.boolean(),
  /** The application server's public key, for `pushManager.subscribe`. */
  publicKey: z.string().nullable(),
  devices: z.array(pushDeviceSchema),
});
export type PushDeviceListResponse = z.infer<typeof pushDeviceListResponseSchema>;

export const sendPushRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(500),
  /**
   * Where tapping it goes. Relative to the deployment or absolute within it;
   * an address pointing anywhere else is refused, because a notification is
   * one of the few things a person taps without reading the target.
   */
  url: z.string().max(2000).optional(),
  /**
   * Replaces an earlier notification carrying the same tag instead of stacking
   * beside it. A status that is sent repeatedly should set one.
   */
  tag: z.string().trim().max(120).optional(),
});
export type SendPushRequest = z.infer<typeof sendPushRequestSchema>;

export const sendPushResponseSchema = z.object({
  /**
   * How many devices it was queued for. Zero is the interesting answer: it
   * means the person has no device accepting this kind, and saying so is the
   * difference between a quiet success and a notification nobody ever gets.
   */
  devices: z.number().int().nonnegative(),
});
export type SendPushResponse = z.infer<typeof sendPushResponseSchema>;

/**
 * What a device receives, and the only thing the service worker parses.
 *
 * `public/sw.js` reads these field names by hand: a plain service worker
 * cannot import a package, so this schema is the contract and that file is the
 * second copy of it. Changing a name here means changing it there.
 */
export const pushNotificationPayloadSchema = z.object({
  kind: pushNotificationKindSchema,
  title: z.string(),
  body: z.string(),
  /** Absolute URL within this deployment, or null for a notification that opens the app. */
  url: z.string().nullable(),
  tag: z.string().nullable(),
});
export type PushNotificationPayload = z.infer<typeof pushNotificationPayloadSchema>;
