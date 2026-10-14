import { describe, expect, it } from 'vitest';

import { EXOCORTEX_TOOLS } from '../catalog.js';
import { BASE_INSTRUCTIONS } from '../instructions.js';

/**
 * The tools an agent reads block ids from or writes Markdown with all say how a
 * section of the same page is linked (issue #197). The agent that wrote
 * `[[#Überschrift]]` had the ids in front of it and nothing telling it what
 * they were for.
 */
const TOOLS_THAT_TEACH_IT = [
  'exo_page_read',
  'exo_page_block_read',
  'exo_page_write',
  'exo_page_block_update',
  'exo_page_patch',
  'exo_page_section_write',
];

describe('section links in the agent surface (issue #197)', () => {
  it.each(TOOLS_THAT_TEACH_IT)('%s names the anchor syntax', (name) => {
    const tool = EXOCORTEX_TOOLS.find((entry) => entry.name === name);
    expect(tool).toBeDefined();
    const said = `${tool?.description ?? ''} ${JSON.stringify(tool?.jsonSchema)}`;
    expect(said).toContain('[Linktext](#blockId)');
  });

  it('warns about the Obsidian form where the anchor syntax is taught at length', () => {
    for (const name of ['exo_page_read', 'exo_page_section_write', 'exo_page_patch']) {
      const tool = EXOCORTEX_TOOLS.find((entry) => entry.name === name);
      expect(tool?.description).toContain('[[#Überschrift]] ist hier kein Abschnittslink');
    }
  });

  it('says it in the handshake an external client puts into its system prompt', () => {
    expect(BASE_INSTRUCTIONS).toContain('[Linktext](#blockId)');
    expect(BASE_INSTRUCTIONS).toContain('[[#Überschrift]] ist hier kein Abschnittslink');
  });
});
