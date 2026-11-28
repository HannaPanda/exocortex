import { describe, expect, it } from 'vitest';

import { type ProseMirrorDocument } from '@exocortex/editor';
import { toolsFor } from '@exocortex/mcp-tools';

import { foreignMediaWarnings } from './document-content.service';

/**
 * The warning a foreign picture earns names tools the reader actually has
 * (issue #212). It began as an agent told to use a tool its client did not
 * list, so every `exo_` name in each variant is checked against the surface
 * that reader is served.
 */

const ORIGIN = 'https://exocortex.app';

const page: ProseMirrorDocument = {
  type: 'doc',
  content: [
    {
      type: 'image',
      attrs: { src: 'https://upload.wikimedia.org/foto.jpg', alt: 'Foto' },
    },
  ],
};

function namedTools(text: string): string[] {
  return [...text.matchAll(/\bexo_[a-z_]+/gu)].map((match) => match[0]);
}

describe('the foreign media warning', () => {
  it('stays quiet for a picture of this deployment', () => {
    const own: ProseMirrorDocument = {
      type: 'doc',
      content: [{ type: 'image', attrs: { src: '/api/attachments/abc/download' } }],
    };
    expect(foreignMediaWarnings(own, ORIGIN, false)).toEqual([]);
  });

  it('tells an external agent about the address import first, and only of mcp tools', () => {
    const [warning] = foreignMediaWarnings(page, ORIGIN, false);
    expect(warning).toContain('upload.wikimedia.org');
    const names = namedTools(warning ?? '');
    expect(names[0]).toBe('exo_attachment_upload_url');
    const mcp = new Set(toolsFor('mcp').map((tool) => tool.name));
    for (const name of names) expect(mcp.has(name), name).toBe(true);
  });

  it('tells the built-in AI only of tools its runs are offered', () => {
    const [warning] = foreignMediaWarnings(page, ORIGIN, true);
    const names = namedTools(warning ?? '');
    expect(names).toEqual(['exo_attachment_upload_url']);
    const ai = new Set(toolsFor('ai').map((tool) => tool.name));
    for (const name of names) expect(ai.has(name), name).toBe(true);
  });
});
