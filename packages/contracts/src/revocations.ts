import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * Immediate withdrawal of authorization (issue #62).
 *
 * HTTP authorization is decided per request, so a revoked member is refused the
 * moment the next call arrives. A WebSocket is decided once, at the handshake,
 * and then lives for hours: without this channel a member who was removed from
 * a workspace kept receiving its events, and a connection that was writable when
 * it opened stayed writable after the role behind it was taken away.
 *
 * The messages travel on their own Redis channel rather than on the application
 * event bus, for two reasons: the event bus fans out into browser rooms, which
 * is precisely where a revocation must not be published, and every process that
 * holds long-lived connections has to see them, not only the API.
 */
export const AUTHORIZATION_REVOCATION_CHANNEL = 'exocortex:revocations';

export const AUTHORIZATION_REVOCATION_REASONS = [
  /** The membership row is gone. */
  'workspace_membership_removed',
  /**
   * The role changed. Sent for a promotion as well as for a demotion: a widened
   * permission must not seep into a connection that was authorized under the
   * old one either, it takes effect when the client authenticates again.
   */
  'workspace_role_changed',
  /** The account was switched off; every workspace is affected. */
  'account_disabled',
  /** The account was deleted outright; every workspace is affected. */
  'account_deleted',
] as const;

export const authorizationRevocationReasonSchema = z.enum(AUTHORIZATION_REVOCATION_REASONS);
export type AuthorizationRevocationReason = z.infer<typeof authorizationRevocationReasonSchema>;

export const authorizationRevocationSchema = z.object({
  userId: idSchema,
  /** `null` means every workspace: the account itself lost its access. */
  workspaceId: idSchema.nullable(),
  reason: authorizationRevocationReasonSchema,
  emittedAt: isoDateTimeSchema,
  correlationId: z.string(),
});
export type AuthorizationRevocation = z.infer<typeof authorizationRevocationSchema>;

/**
 * Server -> browser notice that one workspace subscription was dropped.
 *
 * Kept off `REALTIME_EVENT_NAME`: that name carries workspace-scoped domain
 * events to everybody in a room, while this one is addressed to a single socket
 * and says nothing about the workspace's content. The browser answers it by
 * subscribing again, which re-runs the membership check -- so a role change ends
 * with the client holding whatever the new role allows, and a removal ends with
 * a refusal it can show.
 */
export const REALTIME_REVOCATION_EVENT_NAME = 'exocortex.subscription.revoked';

export const subscriptionRevokedSchema = z.object({
  workspaceId: idSchema,
  reason: authorizationRevocationReasonSchema,
});
export type SubscriptionRevoked = z.infer<typeof subscriptionRevokedSchema>;
