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
  'collaboration_ticket_invalid',
  'collaboration_ticket_expired',
  'collaboration_read_only',
  'attachment_access_denied',
  'ai_provider_unavailable',
  'internal_error',
  'admin_required',
  'api_token_invalid',
  'api_token_expired',
  'ai_model_unknown',
  'ai_model_disabled',
  'ai_tools_unavailable',
  'ai_tool_limit_exceeded',
  'ai_conversation_locked',
  'document_content_conflict',
  'document_content_lossy',
  'attachment_text_unavailable',
  'setting_unknown',
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
  collaboration_ticket_invalid: 401,
  collaboration_ticket_expired: 401,
  collaboration_read_only: 403,
  attachment_access_denied: 403,
  ai_provider_unavailable: 503,
  internal_error: 500,
  admin_required: 403,
  api_token_invalid: 401,
  api_token_expired: 401,
  ai_model_unknown: 404,
  ai_model_disabled: 409,
  ai_tools_unavailable: 503,
  ai_tool_limit_exceeded: 429,
  ai_conversation_locked: 409,
  document_content_conflict: 409,
  document_content_lossy: 422,
  attachment_text_unavailable: 409,
  setting_unknown: 400,
};
