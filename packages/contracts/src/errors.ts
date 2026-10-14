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
  'database_property_config_invalid',
  'database_property_in_use',
  'database_property_date_range_in_use',
  'collaboration_ticket_invalid',
  'collaboration_ticket_expired',
  'collaboration_read_only',
  'attachment_access_denied',
  'ai_provider_unavailable',
  /**
   * No provider of the selected model can serve this request: the prompt is
   * larger than any of their windows, or none supports what the run needs
   * (ADR-032). Distinct from `ai_provider_unavailable`, which means the
   * provider is down -- this one is about the request, and says so.
   */
  'ai_no_eligible_provider',
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
  /** The pagination cursor of a conversation listing is not one this API issued. */
  'ai_conversation_cursor_invalid',
  'document_content_conflict',
  /**
   * A narrow write named a block that is not on the page (issue #111). Its own
   * code rather than `not_found`, because the page was found and the block was
   * not, and a caller that reads the difference knows to read the page again
   * instead of checking the page id.
   */
  'document_block_not_found',
  /** Two block identifiers that are not siblings, or in the wrong order. */
  'document_block_range_invalid',
  'document_heading_not_found',
  /** The heading occurs more than once, so the section is not addressed. */
  'document_heading_not_unique',
  'document_patch_not_found',
  'document_patch_not_unique',
  'document_content_lossy',
  /**
   * An agent tried to make an already oversized page bigger (issue #118). Its
   * own code because the answer is a structural one: the message names the
   * page's biggest sections and the call that moves one away, and a generic
   * refusal would have the writer retry in halves until it fits.
   */
  'document_page_oversized',
  'attachment_text_unavailable',
  /**
   * The image read was asked for a file that is not a raster image it can
   * hand over (issue #204): a PDF, an SVG, a video. The way to the bytes is a
   * download ticket, which the message names.
   */
  'attachment_not_image',
  /**
   * The image could not be brought under the per-image byte limit, or not
   * decoded at all (issue #204). A smaller `maxEdge` is the first thing to try.
   */
  'attachment_image_unreadable',
  'setting_unknown',
  'setting_not_overridable',
  'setting_above_deployment_ceiling',
  'credential_storage_unavailable',
  'memory_unavailable',
  /**
   * Nobody in this memory area answers to the name a message was addressed to
   * (issue #51). Its own code because the caller is usually a model: the
   * details carry the names it may use, and a generic validation failure would
   * have it guess again.
   */
  'agent_message_recipient_unknown',
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
  'project_file_not_found',
  'project_file_exists',
  'project_not_a_text_file',
  'project_patch_not_found',
  'project_patch_not_unique',
  'project_too_many_files',
  'project_write_failed',
  'project_archive_unreadable',
  'project_archive_too_large',
  'project_empty',
  'collaboration_unavailable',
  'web_research_unavailable',
  'web_address_refused',
  'web_fetch_failed',
  /** This page is already a template; marking it a second time would be a no-op. */
  'template_exists',
  /** Only ordinary pages can be templates: not a database, not a project. */
  'template_not_a_page',
  /**
   * The stored question no longer compiles: it filters on a property of a
   * database that has since changed, or it names a database that is gone. The
   * query has to be edited, and no retry will help (issue #74).
   */
  'saved_query_invalid',
  /**
   * The parent a work item was given is in another workspace, is the item
   * itself, or sits below it (issue #138). One code for the three, because
   * the fix is the same: name a different parent.
   */
  'work_item_parent_invalid',
  /** The account named as assignee is not a member of the item's workspace. */
  'work_item_assignee_invalid',
  /** A page named as context or result is not in the item's workspace, or not readable. */
  'work_item_ref_invalid',
  /** The item is done, failed or cancelled; reopen it before starting another run. */
  'work_item_closed',
  /** The linked runs have already spent the item's budget. */
  'work_item_budget_exhausted',
  /**
   * The work item's agent profile says a person closes it (issue #143): a run
   * under that profile sets it to `review` instead of `done`.
   */
  'work_item_review_required',
  /**
   * A child that writes directly cannot start while a directly writing
   * sibling has a run in flight (issue #144); proposing children run together.
   */
  'work_item_sibling_writing',
  /** An id named as a child to wait for or read is not a child of this item. */
  'work_item_child_invalid',
  /** The item has as many children as one piece of work may hand on. */
  'work_item_children_limit',
  /** Only a child the built-in AI holds can be started on handing it on. */
  'work_item_start_needs_assistant',
  /** `done` while a child is still open; close or cancel the children first. */
  'work_item_children_open',
  /**
   * A structured result that does not match the fields the work declared
   * (issue #162): an unknown field, a wrong type, a value not allowed, or a
   * required field missing when the work is handed in. `details.problems`
   * names each one.
   */
  'work_item_result_invalid',
  /** Another agent profile in this workspace already has that name. */
  'agent_profile_name_taken',
  /**
   * A profile names something that is not there: a rule page outside the
   * workspace, or a model that is not enabled.
   */
  'agent_profile_invalid',
  /** Another eval case in this workspace already has that name (issue #146). */
  'eval_case_name_taken',
  /**
   * An eval case names something that is not there, or its checks do not fit
   * its mode: a start page outside the workspace, a profile of another one, a
   * check on a fixture page the case does not bring.
   */
  'eval_case_invalid',
  /** Cases times variants times repetitions is more attempts than one eval run may start. */
  'eval_run_too_large',
  /** A proposal made by an eval attempt is evidence and is never applied (issue #146). */
  'eval_changeset_not_appliable',
  /** The attempt has not finished yet; a review needs its result. */
  'eval_attempt_not_finished',
  /** An eval attempt could not be started: no run came of it. Says nothing about the model. */
  'eval_launch_failed',
  /** Another workflow in this workspace already has that name (issue #160). */
  'workflow_name_taken',
  /** The draft cannot be published as it is; `details.problems` says why, element by element. */
  'workflow_invalid',
  /** The draft moved on since the revision the caller named: re-read, then decide again. */
  'workflow_revision_conflict',
  /** Only a published workflow can be enabled. */
  'workflow_not_published',
  /** Publishing and switching on are a person's, at the browser: never an agent's or a run's (issue #165). */
  'workflow_human_only',
  /** The deployment does not allow external MCP servers (`ai.externalMcpEnabled`, issue #196). */
  'external_mcp_disabled',
  /** Connecting a server or approving its tools is a person's, at the browser (issue #196). */
  'external_mcp_human_only',
  /** Another server in this workspace already has that key. */
  'external_mcp_key_taken',
  /** The workspace already has as many servers as `EXTERNAL_MCP_LIMITS` allows. */
  'external_mcp_limit_reached',
  /** The tool has a problem or was not listed at the last check, so it cannot be approved. */
  'external_mcp_tool_unusable',
  /** A run of the built-in AI drafted an agent under a looser profile than its own; `details.problems` names the nodes. */
  'workflow_exceeds_author',
  /** A run of this workflow has not finished; it cannot be deleted under it. */
  'workflow_has_active_runs',
  /** Workflows are switched off for this workspace (`workflows.enabled`, issue #161). */
  'workflows_disabled',
  /** The run has already finished; there is nothing left to cancel. */
  'workflow_run_finished',
  /** No trigger was named and the version has none or several manual ones. */
  'workflow_trigger_ambiguous',
  /** A work item's first checkpoint came without a summary; later ones carry it forward (issue #142). */
  'work_checkpoint_summary_required',
  /** The named checkpoint does not belong to this work item. */
  'work_checkpoint_not_found',
  /** The attention item was already resolved or became obsolete; it moves only once. */
  'attention_item_settled',
  /** The chosen option is not one the item offers, or the item needs one and none was chosen. */
  'attention_option_invalid',
  /** The item asks for an answer in words, and none was given. */
  'attention_note_required',
  /** The named recipient is not a member of the workspace, or the work item is not in it. */
  'attention_target_invalid',
  /** A page an approval is to be bound to changed since the asker read it (issue #140). */
  'attention_subject_changed',
  /** A workflow's approval is answered by a person, never by an agent or the built-in AI (issue #163). */
  'attention_human_only',
  /** The changeset was already handed in; only a draft takes or loses changes (issue #141). */
  'changeset_not_draft',
  /** Every change of the changeset is decided; nothing is left to apply or reject. */
  'changeset_closed',
  /** A changeset without a single change cannot be handed in. */
  'changeset_empty',
  /** A page, parent, work item or earlier changeset named here is not in this workspace. */
  'changeset_target_invalid',
  /** Pinning context sources is switched off for this workspace (`ai.maxPinnedSources` is 0). */
  'pinned_sources_disabled',
  /** The conversation already pins as many sources as `ai.maxPinnedSources` allows. */
  'pinned_sources_limit_reached',
  /** The saved query does not exist or is not in the conversation's workspace. */
  'saved_query_access_denied',
  /** Only a database page has views, so only one can be pinned as a view. */
  'document_not_a_collection',
  /**
   * The share link does not exist, was withdrawn, or has expired (issue #83).
   * One code for all three on purpose: telling an anonymous caller which of
   * them it was would turn the route into an oracle for guessed tokens.
   */
  'share_link_invalid',
  /** This page is already shared with that account; change the existing share. */
  'share_exists',
  /** Nobody here has that email address, so there is no account to share with. */
  'share_grantee_unknown',
  /** A page cannot be shared with the person who would reach it anyway. */
  'share_grantee_is_member',
  /**
   * The credential is confined to certain pages and this one is not among them
   * (issue #83). Distinct from `document_access_denied`, which is about the
   * account: this one says the *token* is narrower than its owner.
   */
  'token_scope_exceeded',
  /**
   * The upload ticket does not exist, was already used, or has expired
   * (ADR-064). One code for all three, like `share_link_invalid`: the redeem
   * route is public, and telling a caller which it was would make it an
   * oracle for guessed tickets. The cure is the same either way: mint a new one.
   */
  'upload_ticket_invalid',
  /**
   * The download ticket does not exist, was already used, or has expired
   * (issue #204). One code for all three, exactly as `upload_ticket_invalid`.
   */
  'download_ticket_invalid',
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
  database_property_config_invalid: 422,
  database_property_in_use: 409,
  database_property_date_range_in_use: 409,
  collaboration_ticket_invalid: 401,
  collaboration_ticket_expired: 401,
  collaboration_read_only: 403,
  attachment_access_denied: 403,
  ai_provider_unavailable: 503,
  // The request, not the upstream: a smaller prompt or another model works.
  ai_no_eligible_provider: 422,
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
  ai_conversation_cursor_invalid: 400,
  document_content_conflict: 409,
  document_block_not_found: 404,
  document_block_range_invalid: 422,
  document_heading_not_found: 404,
  // 409 rather than 422: the request is well formed, the page is simply in a
  // state where it does not name one section. Naming the candidates in the
  // details is what makes the next call the right one.
  document_heading_not_unique: 409,
  document_patch_not_found: 404,
  document_patch_not_unique: 409,
  document_content_lossy: 422,
  // 409 rather than 422: the request is perfectly well formed, and the same
  // request against the same page a few sections lighter would succeed. It is
  // the page's state that refuses it, which is what 409 says.
  document_page_oversized: 409,
  attachment_text_unavailable: 409,
  // 422: the request is well formed, the file is simply not something the
  // image read can turn into pixels, and asking again will not change that.
  attachment_not_image: 422,
  attachment_image_unreadable: 422,
  setting_unknown: 400,
  // A deployment-wide key arrived in a workspace patch (ADR-023). 400 rather
  // than 403: the caller may well administer this workspace, the key is simply
  // not one a workspace gets to answer.
  setting_not_overridable: 400,
  // An override above the deployment ceiling. Refused rather than clamped, so
  // the form can say what happened; resolving clamps as well, and that is the
  // half that still holds when the ceiling is lowered afterwards.
  setting_above_deployment_ceiling: 400,
  // This deployment has no `CREDENTIAL_ENCRYPTION_KEY`, so a workspace's own
  // provider key cannot be stored (ADR-023). 503 rather than 400: the request
  // was fine, the deployment is missing a line in its environment.
  credential_storage_unavailable: 503,
  // The deployment has no memory area configured, or switched it off. 503,
  // not 404: the route exists and will work once somebody names a workspace.
  memory_unavailable: 503,
  // The addressee is not a member of this memory area. 404 rather than 403:
  // there is nobody to refuse access on behalf of, the name simply answers to
  // no account here.
  agent_message_recipient_unknown: 404,
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
  // The project refusals (issue #43, ADR-027). Each one is its own code rather
  // than one `project_write_refused`, because an agent recovers from them
  // differently: a missing file is created, an occupied path is renamed, an
  // ambiguous patch is re-anchored with more context. One code would force it
  // to parse a German sentence to find out which.
  project_file_not_found: 404,
  project_file_exists: 409,
  project_not_a_text_file: 409,
  project_patch_not_found: 409,
  // The anchor matched more than once. 409, and the message says how often.
  project_patch_not_unique: 409,
  project_too_many_files: 409,
  // The collaboration server took the write and could not apply it. 502: this
  // deployment's own downstream failed, and the caller did nothing wrong.
  project_write_failed: 502,
  // The archive refusals (issue #54). An archive is foreign input, so both of
  // these describe the file the caller sent rather than anything here: one is
  // not a ZIP at all, the other unpacks to more than this deployment allows.
  project_archive_unreadable: 422,
  project_archive_too_large: 413,
  // Nothing to put in an archive. 409 rather than 404: the project is there.
  project_empty: 409,
  // The collaboration server could not be reached at all, so a project write
  // did not happen. 503 rather than 500: it is a service that is down, and
  // trying again in a moment is the right response.
  collaboration_unavailable: 503,
  // Web research is switched off, or this deployment configured no browser and
  // no search instance (issue #26). 503 rather than 404: the route exists and
  // works the moment somebody sets `STEEL_BASE_URL` and flips the setting.
  web_research_unavailable: 503,
  // The address a caller asked for is not one this deployment will fetch: a
  // scheme other than http(s), or a name that resolves somewhere private. 422
  // rather than 403, because nothing about the caller's rights would change it
  // -- it is the address that is wrong, and another one works.
  web_address_refused: 422,
  // The page did not load: DNS failure, a refused connection, a timeout in the
  // browser. 502, because the failure is on the far side and the caller's next
  // move is a different address, not a different token.
  web_fetch_failed: 502,
  template_exists: 409,
  template_not_a_page: 422,
  // 422 rather than 500: the request is well formed and the caller is allowed,
  // but the question it names cannot be asked of the schema as it stands now.
  saved_query_invalid: 422,
  // Well formed and allowed, but the named parent or page cannot be used for
  // this item. 422: a different id fixes it, a retry does not.
  work_item_parent_invalid: 422,
  work_item_assignee_invalid: 422,
  work_item_ref_invalid: 422,
  // 409: the item is in a state that forbids this, and a decision (reopen,
  // raise the budget) is what changes that.
  work_item_closed: 409,
  work_item_budget_exhausted: 409,
  work_item_review_required: 409,
  work_item_sibling_writing: 409,
  work_item_child_invalid: 422,
  work_item_children_limit: 409,
  work_item_start_needs_assistant: 422,
  work_item_children_open: 409,
  work_item_result_invalid: 422,
  agent_profile_name_taken: 409,
  agent_profile_invalid: 400,
  eval_case_name_taken: 409,
  eval_case_invalid: 422,
  eval_run_too_large: 422,
  eval_changeset_not_appliable: 409,
  eval_attempt_not_finished: 409,
  eval_launch_failed: 500,
  workflow_name_taken: 409,
  workflow_invalid: 422,
  workflow_revision_conflict: 409,
  workflow_not_published: 409,
  workflow_human_only: 403,
  external_mcp_disabled: 409,
  external_mcp_human_only: 403,
  external_mcp_key_taken: 409,
  external_mcp_limit_reached: 409,
  external_mcp_tool_unusable: 422,
  workflow_exceeds_author: 422,
  workflow_has_active_runs: 409,
  workflows_disabled: 409,
  workflow_run_finished: 409,
  workflow_trigger_ambiguous: 422,
  work_checkpoint_summary_required: 422,
  work_checkpoint_not_found: 404,
  // Somebody else settled it first, or the work moved on: re-read, do not retry.
  attention_item_settled: 409,
  attention_option_invalid: 422,
  attention_note_required: 422,
  attention_target_invalid: 422,
  attention_subject_changed: 409,
  attention_human_only: 403,
  // The changeset is past the state this asks for: handed in, or decided.
  changeset_not_draft: 409,
  changeset_closed: 409,
  changeset_empty: 422,
  changeset_target_invalid: 422,
  // 409 rather than 403: the deployment allows it, this workspace does not, and
  // the caller's next move is a setting rather than a different token.
  pinned_sources_disabled: 409,
  pinned_sources_limit_reached: 409,
  saved_query_access_denied: 403,
  document_not_a_collection: 422,
  // Unknown link, withdrawn link, expired link: one code and one status for
  // all three (issue #83). 404 for the same reason `invitation_invalid` is
  // one -- an anonymous caller must not be able to tell a wrong guess from a
  // right guess that has been revoked.
  share_link_invalid: 404,
  share_exists: 409,
  share_grantee_unknown: 404,
  // 409 rather than 403: nothing is wrong with the caller, the page simply
  // needs no share to reach the person they named.
  share_grantee_is_member: 409,
  // The credential is genuine and its owner may well be allowed; this token
  // was issued for other pages. 403, because no retry with it will help.
  token_scope_exceeded: 403,
  // 404 for the reason `share_link_invalid` is one: an anonymous caller must
  // not learn whether a ticket ever existed.
  upload_ticket_invalid: 404,
  download_ticket_invalid: 404,
};
