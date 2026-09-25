import { z } from 'zod';

import { localeSchema } from './locale';
import { idSchema, isoDateTimeSchema, workspaceRoleSchema } from './primitives';

/**
 * Invitations (issue #3).
 *
 * Self-registration is off, so an invitation is the only way an account comes
 * into being besides the seed script. Two routes issue one -- the deployment-wide
 * admin area and a workspace's member list -- and they differ only in what they
 * are allowed to grant, never in shape.
 */

/**
 * Role an invitation may grant inside a workspace.
 *
 * OWNER is missing on purpose. Ownership carries destructive powers and is
 * transferred in a deliberate act between two people who are both already here;
 * handing it to an address that has not even accepted yet is a different thing
 * entirely.
 */
export const invitationWorkspaceRoleSchema = z.enum(['ADMIN', 'MEMBER', 'GUEST']);
export type InvitationWorkspaceRole = z.infer<typeof invitationWorkspaceRoleSchema>;

/**
 * What an invitation is right now. Derived by the API from the timestamps rather
 * than stored, so it can never disagree with them.
 */
export const invitationStatusSchema = z.enum(['pending', 'accepted', 'revoked', 'expired']);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const invitationSchema = z.object({
  id: idSchema,
  email: z.string(),
  status: invitationStatusSchema,
  /** Global role the new account will get. Only an admin can set this to admin. */
  role: z.enum(['user', 'admin']),
  /** Workspace the invitation leads into, or null for an instance-only invitation. */
  workspaceId: idSchema.nullable(),
  workspaceName: z.string().nullable(),
  workspaceRole: workspaceRoleSchema.nullable(),
  invitedByName: z.string(),
  invitedByEmail: z.string(),
  expiresAt: isoDateTimeSchema,
  acceptedAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  /** How often the mail went out, including the first attempt. */
  sentCount: z.number().int().nonnegative(),
  /** Null when every send attempt failed -- that is when the link has to be copied. */
  lastSentAt: isoDateTimeSchema.nullable(),
  /**
   * The language the invitation speaks: its mail, and the new account's
   * interface until the person chooses one (issue #98). Null when nobody
   * chose one: then the mail follows the inviter's account language.
   */
  locale: localeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type Invitation = z.infer<typeof invitationSchema>;

export const invitationListResponseSchema = z.object({
  invitations: z.array(invitationSchema),
});
export type InvitationListResponse = z.infer<typeof invitationListResponseSchema>;

/** How long an invitation stays valid when the caller does not say. */
export const INVITATION_DEFAULT_TTL_DAYS = 7;

export const createInvitationRequestSchema = z.object({
  email: z.email(),
  /**
   * Where the invited person lands. Optional on the admin route, implied by the
   * URL on the workspace route. Without one, the account exists but sees nothing
   * until somebody adds them somewhere -- correct for an admin who wants exactly
   * that, wrong as a default, hence the UI always offers a workspace.
   */
  workspaceId: idSchema.optional(),
  workspaceRole: invitationWorkspaceRoleSchema.default('MEMBER'),
  /** Global admin rights for the new account. Rejected unless the caller has them. */
  role: z.enum(['user', 'admin']).default('user'),
  expiresInDays: z.number().int().min(1).max(90).default(INVITATION_DEFAULT_TTL_DAYS),
  /**
   * The language of the mail and of the account it creates (issue #98). The
   * invited person has no account whose choice could be asked, so the inviter
   * decides; the dialog offers the inviter's own interface language. Left
   * out, the mail follows the inviter's account language (German when they
   * never chose one) and the new account follows its browser.
   */
  locale: localeSchema.optional(),
});
export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;

/**
 * The answer to creating or re-sending an invitation.
 *
 * `url` is returned to the caller **once**, for the same reason a new API token
 * is: the raw token is not stored, so this is the only chance to copy it. It
 * matters more here than there, because mail can fail -- `emailSent: false` with
 * a working link is a recoverable situation, and the UI says so.
 */
export const invitationWithLinkSchema = z.object({
  invitation: invitationSchema,
  url: z.string(),
  emailSent: z.boolean(),
});
export type InvitationWithLink = z.infer<typeof invitationWithLinkSchema>;

/**
 * What the acceptance page may know before anybody is signed in.
 *
 * Deliberately thin. It says which address the invitation is for and who sent
 * it, because a person needs to recognise what they are accepting, and it names
 * the workspace so the destination is not a surprise. It says nothing else: this
 * is an unauthenticated endpoint, and a valid-looking token must not become a
 * window into the deployment.
 */
export const invitationPreviewSchema = z.object({
  email: z.string(),
  invitedByName: z.string(),
  workspaceName: z.string().nullable(),
  expiresAt: isoDateTimeSchema,
  /** True when an account for this address already exists; then only sign-in is needed. */
  accountExists: z.boolean(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

/**
 * Redeeming an invitation.
 *
 * The email address is not a field: it comes from the invitation, so a person
 * with a valid token cannot create an account for somebody else's address. The
 * password minimum mirrors `signUpRequestSchema` and Better Auth's own
 * `minPasswordLength`.
 */
export const acceptInvitationRequestSchema = z.object({
  token: z.string().min(16).max(200),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(256),
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

export const acceptInvitationResponseSchema = z.object({
  accepted: z.literal(true),
  email: z.string(),
  /** Where to go after signing in; null when the invitation carried no workspace. */
  workspaceId: idSchema.nullable(),
});
export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponseSchema>;

export const revokeInvitationResponseSchema = z.object({ revoked: z.literal(true) });
export type RevokeInvitationResponse = z.infer<typeof revokeInvitationResponseSchema>;

// ---------------------------------------------------------------------------
// Switching an account off
// ---------------------------------------------------------------------------

/**
 * Disabling and re-enabling an account.
 *
 * The counterpart to inviting: a deployment that can let people in has to be
 * able to let them back out. Disabling rather than deleting, because documents
 * point at their author -- see `AdminUser.disabledAt` and the DELETE route for
 * the case where deletion really is what is wanted.
 */
export const updateUserStatusRequestSchema = z.object({ disabled: z.boolean() });
export type UpdateUserStatusRequest = z.infer<typeof updateUserStatusRequestSchema>;

/**
 * Deleting an account outright.
 *
 * Only possible for an account that authored nothing: `Document.createdById` is
 * a required reference, so the database itself refuses to let an author vanish
 * from under their pages. That refusal is a feature, not an obstacle to route
 * around -- an account with a history gets disabled instead, and the API says so
 * with `user_has_content`. What this route is for is the invitation that went to
 * the wrong address, or the account nobody ever used.
 */
export const deleteUserResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteUserResponse = z.infer<typeof deleteUserResponseSchema>;
