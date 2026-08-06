import { describe, expect, it } from 'vitest';

import { EXOCORTEX_TOOLS, toolsFor } from './catalog.js';

describe('EXOCORTEX_TOOLS', () => {
  it('has unique names, all starting with exo_', () => {
    const names = EXOCORTEX_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.startsWith('exo_')).toBe(true);
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

  it('produces a JSON Schema for every tool input', () => {
    for (const tool of EXOCORTEX_TOOLS) {
      expect(tool.jsonSchema).toBeTypeOf('object');
      expect(tool.jsonSchema).not.toBeNull();
    }
  });

  it('excludes mutating tools from the read-only AI surface', () => {
    const readOnlyAiTools = toolsFor('ai', { includeMutating: false });
    expect(readOnlyAiTools.length).toBeGreaterThan(0);
    for (const tool of readOnlyAiTools) {
      expect(tool.mutating).toBe(false);
    }
  });
});
