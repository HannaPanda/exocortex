import { describe, expect, it } from 'vitest';

import { EXOCORTEX_TOOLS, findTool, toolsFor } from './catalog.js';
import { type ExocortexApiClient } from './client.js';
import { TOOL_DOMAINS } from './tool.js';

describe('EXOCORTEX_TOOLS', () => {
  it('has unique names', () => {
    const names = EXOCORTEX_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('prefixes every tool with exo_ except the ones on the small client surfaces', () => {
    // The prefix exists so the catalogue cannot collide with the other MCP
    // servers a client spawns alongside it. The exceptions live on the two
    // deliberately tiny surfaces a person configures on their own URL:
    // `research`, where ChatGPT's deep research connector matches on the exact
    // names `search` and `fetch`, and `memory` (issue #34), where the model
    // should reach for the word a memory is called by. Neither name is ever
    // offered on the full catalogue or to the built-in AI.
    const smallSurfaces = ['research', 'memory'];
    for (const tool of EXOCORTEX_TOOLS) {
      const onSmallSurface = tool.surfaces.some((surface) => smallSurfaces.includes(surface));
      if (onSmallSurface) {
        expect(['search', 'fetch', 'recall', 'remember']).toContain(tool.name);
        expect(tool.surfaces.every((surface) => smallSurfaces.includes(surface))).toBe(true);
      } else {
        expect(tool.name.startsWith('exo_')).toBe(true);
      }
    }
  });

  it('keeps the memory surface at three tools, one of which writes', () => {
    // Three, not four and not forty-six: a chat client that is handed choices
    // stops picking the right one, and this surface exists to be picked from
    // reliably (issue #34, AP3).
    const memory = toolsFor('memory');
    expect(memory.map((tool) => tool.name).sort()).toEqual(['fetch', 'recall', 'remember']);
    expect(memory.filter((tool) => tool.mutating).map((tool) => tool.name)).toEqual(['remember']);
    // `remember` adds; it never replaces what somebody else wrote.
    expect(memory.every((tool) => tool.destructive !== true)).toBe(true);
  });

  it('keeps the research surface read-only and small', () => {
    const research = toolsFor('research');
    expect(research.map((tool) => tool.name).sort()).toEqual(['fetch', 'search']);
    for (const tool of research) {
      expect(tool.mutating).toBe(false);
    }
  });

  it('has a non-trivial German description for every tool', () => {
    for (const tool of EXOCORTEX_TOOLS) {
      expect(tool.description.length).toBeGreaterThanOrEqual(20);
      expect(tool.description).not.toMatch(/TODO|FIXME/);
    }
  });

  it('declares a target for every mutating tool', () => {
    for (const tool of EXOCORTEX_TOOLS) {
      if (tool.mutating) {
        expect(tool.hasTarget).toBe(true);
      }
    }
  });

  it('marks the deletions and overwrites as destructive, and nothing else', () => {
    // Pinned by name rather than by rule, because the list is the judgement
    // call: everything here removes content or writes over content a person
    // authored, and a tool that quietly joins the list should have to say so
    // in a diff.
    //
    // The four access-related entries (issue #3) are destructive in a second
    // sense the word has to stretch to cover: they take away something a person
    // is holding rather than something they wrote. Withdrawing or re-sending an
    // invitation kills a link somebody may be about to click, and switching an
    // account off or deleting it ends a session mid-sentence. A client that asks
    // before destructive calls should ask before those too.
    //
    // The three entity entries (issue #47) are the same stretch a third time:
    // an alias list is replaced wholesale rather than added to, unlinking a page
    // removes an edge somebody may have drawn by hand, and dismissing a
    // candidate deletes the evidence along with the decision.
    //
    // Deleting an automation (issue #50) takes its run log with it, which is
    // the only record of what that rule ever did. Changing a rule is not here:
    // the rule is small, visible in full in the list, and a wrong change is one
    // more call away from being right again.
    //
    // Deleting a render template (issue #44) is the same judgement: the PDFs
    // built from it survive, but nothing can rebuild them. Starting a build is
    // deliberately not destructive -- it adds a file and changes no page.
    //
    // The three project entries (issue #43) each discard something: an
    // overwrite loses the previous text, a move breaks every `\input` that
    // named the old path, and a delete takes a file out of the tree. None of
    // them is irreversible, because a project's document takes the same session
    // snapshots a page does. Patching is not here for the reason a patch is
    // safer than a write: it either matches what is there now or refuses.
    const destructive = EXOCORTEX_TOOLS.filter((tool) => tool.destructive)
      .map((tool) => tool.name)
      .sort();
    expect(destructive).toEqual([
      'exo_attachment_correct_text',
      'exo_attachment_reextract_text',
      'exo_automation_delete',
      'exo_comment_delete',
      'exo_comment_update',
      'exo_database_option_delete',
      'exo_database_option_update',
      'exo_database_property_delete',
      'exo_database_property_update',
      'exo_database_row_update',
      'exo_database_view_delete',
      'exo_database_view_update',
      'exo_entity_candidate_dismiss',
      'exo_entity_unlink_page',
      'exo_entity_update',
      'exo_invitation_resend',
      'exo_invitation_revoke',
      'exo_page_archive',
      'exo_page_delete',
      'exo_page_rename',
      // A partial restore (issue #77) overwrites blocks somebody authored, and
      // takes out the ones the snapshot never had. The state before it is
      // snapshotted first, so it is destructive without being irreversible.
      'exo_page_restore_blocks',
      'exo_page_restore_snapshot',
      'exo_page_write',
      'exo_project_build_delete',
      'exo_project_delete_file',
      // With `overwrite`, an import replaces files that are already there.
      'exo_project_import',
      'exo_project_move_file',
      'exo_project_write_file',
      'exo_render_delete',
      'exo_render_template_delete',
      // Deleting a saved query (issue #74) takes away a stored question that
      // nothing else holds. The pages it found are untouched, which is why it
      // is not irreversible in the sense below, but the question itself has no
      // snapshot and no trash.
      'exo_saved_query_delete',
      'exo_user_delete',
      'exo_user_set_disabled',
      'exo_workspace_rename',
    ]);
  });

  it('reserves the confirmation gate for what no snapshot brings back', () => {
    // Pinned by name for the same reason the destructive list is: this is the
    // judgement call, and it is the only list that still costs a caller two
    // round trips. Everything absent from it is covered by something better --
    // the pre-write snapshot, the trash, or a second click in the client.
    //
    // Archiving is not here: the page is in the trash, and exo_page_restore
    // takes it back out. Restoring a snapshot is not here either: it takes one
    // of its own first, so the state it replaced is still reachable.
    // An automation rule is: nothing snapshots it, and its run log goes with
    // it. Switching it off is the reversible act, and that is a separate call
    // on purpose. A select option is, for the same reason its column is: making
    // it again gives it a new id, and the rows that had it stay empty. A render
    // template is: the PDFs built from it stay, but nothing can rebuild them,
    // and a LaTeX preamble somebody spent an afternoon on is not something the
    // trash holds a copy of. Creating a share is the one entry here that
    // deletes nothing (issue #83): a public address is out the moment it is
    // made, and revoking it afterwards does not unread the page.
    const irreversible = EXOCORTEX_TOOLS.filter((tool) => tool.irreversible)
      .map((tool) => tool.name)
      .sort();
    expect(irreversible).toEqual([
      'exo_automation_delete',
      'exo_comment_delete',
      'exo_database_option_delete',
      'exo_database_property_delete',
      'exo_page_delete',
      'exo_render_template_delete',
      'exo_share_create',
      'exo_user_delete',
    ]);
  });

  it('never calls a read-only tool irreversible, and names the one that deletes nothing', () => {
    for (const tool of EXOCORTEX_TOOLS) {
      if (!tool.irreversible) continue;
      expect(tool.mutating).toBe(true);
      // Irreversible is almost always destructive too, and the exception is
      // pinned rather than allowed in general: a share creates an address, and
      // an address cannot be taken back out of somebody's memory.
      if (tool.name !== 'exo_share_create') expect(tool.destructive).toBe(true);
    }
  });

  it('produces a JSON Schema for every tool input', () => {
    for (const tool of EXOCORTEX_TOOLS) {
      expect(tool.jsonSchema).toBeTypeOf('object');
      expect(tool.jsonSchema).not.toBeNull();
    }
  });

  /**
   * OpenAI validates the whole `tools` array and rejects the *entire request*
   * over one unsupported pattern. `z.email()` emits `^(?!\.)(?!.*\.\.)…`, so
   * adding `exo_invitation_create` disabled the built-in AI's tool loop
   * altogether: every run failed with `ai_provider_unavailable` and nothing in
   * the log named the tool responsible.
   */
  it('emits no regex lookaround in any tool schema', () => {
    const lookaround = /\(\?[=!]|\(\?<[=!]/;
    for (const tool of EXOCORTEX_TOOLS) {
      expect(
        lookaround.test(JSON.stringify(tool.jsonSchema)),
        `${tool.name} carries a pattern OpenAI refuses`,
      ).toBe(false);
    }
  });

  it('keeps run-lifecycle tools away from the built-in AI (issue #6)', () => {
    // Everything else in the catalogue is offered on both surfaces. These two
    // are not, and the reason is worth an assertion: a tool loop that can
    // cancel a run can cancel the run it is itself executing in.
    const aiToolNames = toolsFor('ai').map((tool) => tool.name);
    expect(aiToolNames).not.toContain('exo_ai_run_cancel');
    expect(aiToolNames).not.toContain('exo_ai_run_get');
    const mcpToolNames = toolsFor('mcp').map((tool) => tool.name);
    expect(mcpToolNames).toContain('exo_ai_run_cancel');
    expect(mcpToolNames).toContain('exo_ai_run_get');
  });

  it('excludes mutating tools from the read-only AI surface', () => {
    const readOnlyAiTools = toolsFor('ai', { includeMutating: false });
    expect(readOnlyAiTools.length).toBeGreaterThan(0);
    for (const tool of readOnlyAiTools) {
      expect(tool.mutating).toBe(false);
    }
  });
});

/**
 * The domain every tool carries (issue #121, ADR-060).
 *
 * The compiler already refuses a tool without one, so what is left to check is
 * what a type cannot say: that the domains are actually used, that narrowing
 * changes nothing about which surface a tool is on, and that the one tool
 * which exists only for the narrowing behaves like it.
 */
describe('tool domains', () => {
  it('puts every tool in a domain that the vocabulary knows', () => {
    for (const tool of EXOCORTEX_TOOLS) {
      expect(TOOL_DOMAINS, tool.name).toContain(tool.domain);
    }
  });

  it('spreads the catalogue over the domains instead of parking it in one', () => {
    // A taxonomy where everything is `core` would pass every other test here
    // and save nothing.
    const used = new Set(EXOCORTEX_TOOLS.map((tool) => tool.domain));
    expect(used.size).toBeGreaterThan(TOOL_DOMAINS.length / 2);
    const core = EXOCORTEX_TOOLS.filter((tool) => tool.domain === 'core');
    expect(core.length).toBeLessThan(EXOCORTEX_TOOLS.length / 4);
  });

  it('narrows within a surface and never across it', () => {
    const narrowed = toolsFor('ai', { domains: ['core', 'projects'] });
    expect(narrowed.every((tool) => tool.surfaces.includes('ai'))).toBe(true);
    expect(narrowed.every((tool) => ['core', 'projects'].includes(tool.domain))).toBe(true);
    // Leaving the option out is the handshake, unchanged.
    expect(toolsFor('ai').length).toBe(toolsFor('ai', {}).length);
  });

  it('keeps narrowing and the mutating switch independent of each other', () => {
    const readOnly = toolsFor('ai', { domains: ['core', 'pages'], includeMutating: false });
    expect(readOnly.every((tool) => !tool.mutating)).toBe(true);
    expect(readOnly.map((tool) => tool.name)).toContain('exo_page_read');
    expect(readOnly.map((tool) => tool.name)).not.toContain('exo_page_write');
  });

  it('offers the way back on the surface that needs one, and nowhere else', () => {
    const toolbox = findTool('exo_toolbox');
    expect(toolbox).not.toBeNull();
    // An MCP client holds the whole catalogue already; a tool telling it about
    // domains it was never denied would be noise with a reason attached.
    expect(toolbox?.surfaces).toEqual(['ai']);
    expect(toolbox?.domain).toBe('core');
    expect(toolbox?.mutating).toBe(false);
    expect(toolsFor('mcp').map((tool) => tool.name)).not.toContain('exo_toolbox');
  });

  it('names every domain when it is asked without one, and lists a domain when it is asked with one', async () => {
    const toolbox = findTool('exo_toolbox');
    if (toolbox === null) throw new Error('the toolbox is gone');
    const client = {
      request: () => Promise.reject(new Error('the toolbox reaches no route')),
      upload: () => Promise.reject(new Error('the toolbox reaches no route')),
    } as unknown as ExocortexApiClient;

    const all = await toolbox.run(client, {});
    for (const domain of TOOL_DOMAINS) expect(all.text).toContain(domain);

    const one = await toolbox.run(client, { domain: 'databases' });
    expect(one.text).toContain('exo_database_query');
    expect(one.text).not.toContain('exo_project_build');
  });
});
