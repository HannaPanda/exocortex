import { describe, expect, it } from 'vitest';

import { toolsFor } from './catalog.js';
import {
  COMPACT_ENDPOINT_EXECUTABLE,
  COMPACT_WITHHELD,
  compactWithholding,
} from './compact-executable.js';
import { COMPACT_ENDPOINT_DOMAINS } from './domains.js';

/**
 * The criteria of `compact-executable.ts` against the whole catalogue
 * (issue #265). The allowlist is derived, so this file is where a widening
 * becomes visible: a new tool that passes every criterion turns the pinned
 * list red until somebody decided it belongs there, and a tool that should
 * never be reachable is named below by what it is.
 */

const full = toolsFor('mcp');
const byName = new Map(full.map((tool) => [tool.name, tool]));
const listed = new Set(
  toolsFor('mcp', { domains: COMPACT_ENDPOINT_DOMAINS }).map((tool) => tool.name),
);
const executable = COMPACT_ENDPOINT_EXECUTABLE.map((name) => {
  const tool = byName.get(name);
  if (tool === undefined) throw new Error(`${name} is not on the mcp surface`);
  return tool;
});

/**
 * What the compact endpoint's dispatchers reach today. Adding a name here is
 * a decision about what a connector may do over OAuth with the person's whole
 * authority; read the criteria before you do.
 */
const PINNED = [
  'exo_agent_message_read',
  'exo_agent_message_send',
  'exo_agent_messages',
  'exo_agent_profile_get',
  'exo_agent_profile_list',
  'exo_agent_session_get',
  'exo_agent_session_list',
  'exo_ai_run_changes',
  'exo_attachment_read_image',
  'exo_attachment_read_text',
  'exo_attachment_upload',
  'exo_attention_get',
  'exo_attention_list',
  'exo_attention_request',
  'exo_attention_withdraw',
  'exo_automation_list',
  'exo_automation_runs',
  'exo_changeset_get',
  'exo_changeset_list',
  'exo_changeset_propose',
  'exo_changeset_remove_change',
  'exo_changeset_submit',
  'exo_chat_context',
  'exo_chat_list',
  'exo_chat_read',
  'exo_chat_search',
  'exo_entity_candidate_confirm',
  'exo_entity_candidates',
  'exo_entity_create',
  'exo_entity_link_page',
  'exo_entity_list',
  'exo_entity_profile',
  'exo_eval_attempt_get',
  'exo_eval_case_get',
  'exo_eval_case_list',
  'exo_eval_compare',
  'exo_eval_run_get',
  'exo_eval_run_list',
  'exo_eval_suite_export',
  'exo_knowledge_map_appearance',
  'exo_knowledge_map_appearance_set',
  'exo_me_preferences',
  'exo_me_preferences_set',
  'exo_memory_facts',
  'exo_notification_preference_set',
  'exo_notification_preferences',
  'exo_page_generate_cover',
  'exo_page_overview_read',
  'exo_page_overview_refresh',
  'exo_page_set_ai_rule',
  'exo_page_set_cover',
  'exo_page_set_layout',
  'exo_page_set_overview',
  'exo_project_add_asset',
  'exo_project_build',
  'exo_project_build_artifacts',
  'exo_project_build_cancel',
  'exo_project_build_diagnostics',
  'exo_project_build_log',
  'exo_project_build_position_of',
  'exo_project_build_source_at',
  'exo_project_build_status',
  'exo_project_builds',
  'exo_project_create',
  'exo_project_export',
  'exo_project_list',
  'exo_project_list_files',
  'exo_project_patch_file',
  'exo_project_read',
  'exo_project_read_file',
  'exo_project_update',
  'exo_push_device_update',
  'exo_push_devices',
  'exo_render_artifact',
  'exo_render_cancel',
  'exo_render_jobs',
  'exo_render_log',
  'exo_render_start',
  'exo_render_status',
  'exo_render_template_create',
  'exo_render_template_list',
  'exo_render_template_read',
  'exo_render_template_update',
  'exo_saved_query_create',
  'exo_saved_query_get',
  'exo_saved_query_list',
  'exo_saved_query_preview',
  'exo_saved_query_reorder',
  'exo_saved_query_run',
  'exo_saved_query_update',
  'exo_work_item_await_children',
  'exo_work_item_checkpoint',
  'exo_work_item_checkpoints',
  'exo_work_item_child_results',
  'exo_work_item_create',
  'exo_work_item_delegate',
  'exo_work_item_get',
  'exo_work_item_list',
  'exo_work_item_note',
  'exo_work_item_start_run',
  'exo_work_item_update',
  'exo_workflow_create',
  'exo_workflow_duplicate',
  'exo_workflow_get',
  'exo_workflow_list',
  'exo_workflow_run_get',
  'exo_workflow_runs',
  'exo_workflow_validate',
  'exo_workflow_version_get',
  'exo_workflow_versions',
];

describe('the compact endpoint allowlist', () => {
  it('is exactly the pinned list, so nothing is released without a decision', () => {
    expect([...COMPACT_ENDPOINT_EXECUTABLE]).toEqual(PINNED);
  });

  it('names only tools the compact list leaves out', () => {
    for (const tool of executable) expect(listed.has(tool.name), tool.name).toBe(false);
  });

  it('never reaches a tool that destroys or cannot be undone', () => {
    for (const tool of executable) {
      expect(tool.destructive || tool.irreversible, tool.name).toBe(false);
    }
  });

  it('reaches only what the built-in AI may use as well', () => {
    for (const tool of executable) expect(tool.surfaces, tool.name).toContain('ai');
  });

  it('never reaches accounts, invitations, shares or deployment settings', () => {
    for (const tool of executable) {
      expect(['admin', 'shares'], tool.name).not.toContain(tool.domain);
    }
  });

  it('never writes an automation rule and never reaches the open web', () => {
    for (const tool of executable) {
      expect(tool.mutating && tool.domain === 'automations', tool.name).toBe(false);
      expect(tool.untrustedOutput, tool.name).not.toBe('web');
    }
  });

  it('withholds the decisions a person keeps', () => {
    for (const name of [
      'exo_changeset_apply',
      'exo_changeset_reject',
      'exo_workflow_run_start',
      'exo_workflow_run_cancel',
      'exo_agent_profile_create',
      'exo_agent_profile_update',
      'exo_attention_resolve',
      'exo_memory_fact_promote',
      'exo_eval_attempt_review',
      'exo_ai_run_cancel',
    ]) {
      expect(byName.has(name), name).toBe(true);
      expect(COMPACT_ENDPOINT_EXECUTABLE, name).not.toContain(name);
    }
  });

  it('withholds every tool about people, access and credentials', () => {
    const reached = full.filter(
      (tool) =>
        /^exo_(user|invitation|share|shared|workspace_rename|tool_routing)/u.test(tool.name) &&
        COMPACT_ENDPOINT_EXECUTABLE.includes(tool.name),
    );
    expect(reached.map((tool) => tool.name)).toEqual([]);
  });

  it('keeps every named exception pointed at a tool that exists and would otherwise pass', () => {
    for (const name of Object.keys(COMPACT_WITHHELD)) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      if (tool === undefined) continue;
      expect(compactWithholding(tool), name).toBe('withheld');
    }
  });
});
