import { describe, expect, it } from 'vitest';

import { EXOCORTEX_TOOLS, toolsFor } from './catalog.js';

describe('EXOCORTEX_TOOLS', () => {
  it('has unique names', () => {
    const names = EXOCORTEX_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('prefixes every tool with exo_ except the two ChatGPT dictates', () => {
    // The prefix exists so the catalogue cannot collide with the other MCP
    // servers a client spawns alongside it. `search` and `fetch` are the
    // exception because ChatGPT's deep research connector matches on those
    // exact names; they live on their own surface, which no other client sees.
    for (const tool of EXOCORTEX_TOOLS) {
      if (tool.surfaces.includes('research')) {
        expect(['search', 'fetch']).toContain(tool.name);
        expect(tool.surfaces).toEqual(['research']);
      } else {
        expect(tool.name.startsWith('exo_')).toBe(true);
      }
    }
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
      'exo_page_archive',
      'exo_page_rename',
      'exo_page_restore_snapshot',
      'exo_page_write',
      'exo_workspace_rename',
    ]);
  });

  it('produces a JSON Schema for every tool input', () => {
    for (const tool of EXOCORTEX_TOOLS) {
      expect(tool.jsonSchema).toBeTypeOf('object');
      expect(tool.jsonSchema).not.toBeNull();
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
