import { describe, expect, it } from 'vitest';

import { toolCallTarget } from './ai-run';

/**
 * The compact argument extract that goes onto `ai.run.tool_call` (issue #6).
 *
 * "Werkzeug exo_page_write wird ausgeführt" never said *on which page*, which
 * is the interesting half during a rebuild with dozens of calls. The extract
 * closes that gap, and the rule it has to keep is that it carries identifiers
 * and nothing else: a tool call's arguments contain whole pages of text, and
 * an event bus and a log are not places for those.
 */
describe('toolCallTarget', () => {
  it('names the page a write touches', () => {
    const target = toolCallTarget(
      'exo_page_write',
      JSON.stringify({ documentId: 'doc123456789', markdown: '# Gaming', mode: 'append' }),
    );
    expect(target).toBe('document:doc123456789');
  });

  it('leaves the written content out of the extract entirely', () => {
    const secret = 'Passwort ist hunter2, und hier stehen 108 Wikilinks';
    const target = toolCallTarget(
      'exo_page_write',
      JSON.stringify({ documentId: 'doc123456789', markdown: secret, mode: 'replace' }),
    );
    expect(target).toBe('document:doc123456789');
    expect(target).not.toContain('hunter2');
    expect(target).not.toContain('Wikilinks');
    expect(target).not.toContain('replace');
  });

  it('names the workspace a workspace-level write touches', () => {
    const target = toolCallTarget(
      'exo_workspace_rename',
      JSON.stringify({ workspaceId: 'ws1234567890', name: 'Zweites Gehirn' }),
    );
    expect(target).toBe('workspace:ws1234567890');
  });

  it('reports nothing for a read-only tool, which has no write target', () => {
    expect(
      toolCallTarget('exo_search', JSON.stringify({ workspaceId: 'ws1234567890', q: 'gaming' })),
    ).toBeNull();
  });

  it('reports nothing rather than throwing when the arguments are not valid JSON', () => {
    // Exactly what a run truncated at the output cap produces: a tool call
    // whose arguments stop mid-JSON. Reporting the call still has to work.
    expect(toolCallTarget('exo_page_write', '{"documentId":"doc12345678","markdown":"# Gam')).toBeNull();
  });

  it('reports nothing for an unknown tool name', () => {
    expect(toolCallTarget('exo_not_a_tool', JSON.stringify({ documentId: 'doc123456789' }))).toBeNull();
  });

  it('reports nothing when the arguments do not satisfy the tool schema', () => {
    expect(toolCallTarget('exo_page_write', JSON.stringify({ markdown: 'ohne Ziel' }))).toBeNull();
  });
});
