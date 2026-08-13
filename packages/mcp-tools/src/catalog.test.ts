import { describe, expect, it } from 'vitest';

import { EXOCORTEX_TOOLS, toolsFor } from './catalog.js';

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
    const destructive = EXOCORTEX_TOOLS.filter((tool) => tool.destructive)
      .map((tool) => tool.name)
      .sort();
    expect(destructive).toEqual([
      'exo_attachment_correct_text',
      'exo_attachment_reextract_text',
      'exo_comment_delete',
      'exo_comment_update',
      'exo_database_property_delete',
      'exo_database_property_update',
      'exo_database_row_update',
      'exo_database_view_delete',
      'exo_database_view_update',
      'exo_invitation_resend',
      'exo_invitation_revoke',
      'exo_page_archive',
      'exo_page_delete',
      'exo_page_rename',
      'exo_page_restore_snapshot',
      'exo_page_write',
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
    const irreversible = EXOCORTEX_TOOLS.filter((tool) => tool.irreversible)
      .map((tool) => tool.name)
      .sort();
    expect(irreversible).toEqual([
      'exo_comment_delete',
      'exo_database_property_delete',
      'exo_page_delete',
      'exo_user_delete',
    ]);
  });

  it('never calls a reversible tool irreversible, or a read-only one either', () => {
    for (const tool of EXOCORTEX_TOOLS) {
      if (tool.irreversible) {
        expect(tool.mutating).toBe(true);
        expect(tool.destructive).toBe(true);
      }
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
