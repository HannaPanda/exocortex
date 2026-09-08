import { z } from 'zod';

/**
 * Machine-readable API error identifiers. English by design: these are
 * developer-facing contract values, never user-visible copy.
 *
 * The web application maps codes to German messages
 * (`apps/web/src/lib/api/error-messages.ts`).
 */
export const API_ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'session_expired',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'payload_too_large',
  'unsupported_media_type',
  'workspace_access_denied',
  'document_access_denied',
  'document_archived',
  'document_move_cycle',
  'document_cross_workspace',
  'database_property_reserved',
  'database_property_date_range_in_use',
  'collaboration_ticket_invalid',
  'collaboration_ticket_expired',
  'collaboration_read_only',
  'attachment_access_denied',
  'ai_provider_unavailable',
  'internal_error',
  'admin_required',
  'api_token_invalid',
  'api_token_expired',
  'api_token_insufficient_scope',
  'ai_model_unknown',
  'ai_model_disabled',
  'ai_tools_unavailable',
  'ai_image_unavailable',
  'ai_tool_limit_exceeded',
  'ai_conversation_locked',
  'document_content_conflict',
  'document_content_lossy',
  'attachment_text_unavailable',
  'setting_unknown',
  'memory_unavailable',
  'entity_layer_unavailable',
  'entity_exists',
  'entity_candidate_promoted',
  'workspace_slug_taken',
  'invitation_invalid',
  'invitation_expired',
  'invitation_already_used',
  'invitation_email_taken',
  'user_disabled',
  'user_has_content',
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorResponseSchema = z.object({
  code: apiErrorCodeSchema,
  /** Developer-facing English message. Never rendered directly to users. */
  message: z.string(),
  details: z.unknown().optional(),
  correlationId: z.string(),
});

export interface ApiErrorResponse {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
  correlationId: string;
}

/** HTTP status mapping for every error code. Single source of truth. */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  session_expired: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_media_type: 415,
  workspace_access_denied: 403,
  document_access_denied: 403,
  document_archived: 409,
  document_move_cycle: 422,
  document_cross_workspace: 422,
  database_property_reserved: 422,
  database_property_date_range_in_use: 409,
  collaboration_ticket_invalid: 401,
  collaboration_ticket_expired: 401,
  collaboration_read_only: 403,
  attachment_access_denied: 403,
  ai_provider_unavailable: 503,
  internal_error: 500,
  admin_required: 403,
  api_token_invalid: 401,
  api_token_expired: 401,
  // The credential is valid, it simply may not do this. 403, not 401: retrying
  // with the same token will never help.
  api_token_insufficient_scope: 403,
  ai_model_unknown: 404,
  ai_model_disabled: 409,
  ai_tools_unavailable: 503,
  ai_image_unavailable: 503,
  ai_tool_limit_exceeded: 429,
  ai_conversation_locked: 409,
  document_content_conflict: 409,
  document_content_lossy: 422,
  attachment_text_unavailable: 409,
  setting_unknown: 400,
  // The deployment has no memory area configured, or switched it off. 503,
  // not 404: the route exists and will work once somebody names a workspace.
  memory_unavailable: 503,
  // No entity database is configured, or the layer is switched off. 503 for
  // the same reason as above: the route works the moment somebody names one.
  entity_layer_unavailable: 503,
  // An entity with this name is already there. 409 rather than a silent reuse:
  // adding a spelling to the existing one is almost always what was meant, and
  // quietly returning the other row would hide the collision.
  entity_exists: 409,
  // The candidate has already become an entity. Confirming it twice would
  // create a second row for the same name.
  entity_candidate_promoted: 409,
  workspace_slug_taken: 409,
  // Unknown token, or one that was revoked. 404, not 401: there is nothing to
  // authenticate as, and every wrong token has to look identical -- a 401 here
  // and a 404 there would tell somebody probing which tokens exist.
  invitation_invalid: 404,
  invitation_expired: 410,
  invitation_already_used: 409,
  // Somebody already has an account for this address, so an invitation would
  // create a second one. They sign in instead.
  invitation_email_taken: 409,
  // The credential is genuine and the account exists; it has been switched off.
  // 403, not 401: signing in again will not help.
  user_disabled: 403,
  // The account authored pages, comments or uploads, so it cannot be deleted
  // without taking that history with it. Disabling is the way out.
  user_has_content: 409,
};
