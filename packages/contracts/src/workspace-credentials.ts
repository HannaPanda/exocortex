import { z } from 'zod';

import { isoDateTimeSchema } from './primitives';

/**
 * A workspace's own third-party credentials (issue #52, AP7, ADR-023).
 *
 * Deliberately not part of `settings.ts`: ADR-013 says a setting is a
 * preference and never a credential, and keeping the two in separate files is
 * the cheapest way to keep somebody from adding a key to `settingsSchema`
 * because it happened to be nearby. Nothing here ever carries the secret back
 * out; a response says whether one is stored, what it ends in, and when.
 */

export const WORKSPACE_CREDENTIAL_PURPOSES = ['AI_OPENROUTER'] as const;
export const workspaceCredentialPurposeSchema = z.enum(WORKSPACE_CREDENTIAL_PURPOSES);
export type WorkspaceCredentialPurpose = z.infer<typeof workspaceCredentialPurposeSchema>;

/** Everything the browser may learn about a stored credential. */
export const workspaceCredentialSchema = z.object({
  purpose: workspaceCredentialPurposeSchema,
  configured: z.boolean(),
  /**
   * The last four characters, or an empty string for a secret short enough
   * that four characters would be most of it. Never the value.
   */
  hint: z.string(),
  updatedAt: isoDateTimeSchema.nullable(),
  /** When a run last paid with this key, so "stored" and "in use" differ on screen. */
  lastUsedAt: isoDateTimeSchema.nullable(),
});
export type WorkspaceCredential = z.infer<typeof workspaceCredentialSchema>;

export const workspaceCredentialListResponseSchema = z.object({
  credentials: z.array(workspaceCredentialSchema),
  /**
   * Whether this deployment can store credentials at all, i.e. whether
   * `CREDENTIAL_ENCRYPTION_KEY` is configured. Sent so the form can say "this
   * deployment has no encryption key" instead of failing on save.
   */
  available: z.boolean(),
});
export type WorkspaceCredentialListResponse = z.infer<typeof workspaceCredentialListResponseSchema>;

/**
 * Storing or replacing one key.
 *
 * The minimum length is a typo guard, not a policy: a pasted OpenRouter key is
 * far longer, and anything shorter than this is a truncated paste that would
 * only fail later, inside a run, as an authentication error from the provider.
 */
export const setWorkspaceCredentialRequestSchema = z.object({
  secret: z.string().trim().min(20).max(400),
});
export type SetWorkspaceCredentialRequest = z.infer<typeof setWorkspaceCredentialRequestSchema>;
