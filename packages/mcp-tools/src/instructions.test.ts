import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from './client.js';
import { BASE_INSTRUCTIONS, buildServerInstructions } from './instructions.js';

/** A client that answers the three endpoints the handshake reads, and nothing else. */
function clientWith(responses: Record<string, unknown>): ExocortexApiClient {
  return {
    async request(input) {
      const body = responses[input.path];
      if (body === undefined) throw new Error(`unexpected path: ${input.path}`);
      return input.responseSchema.parse(body);
    },
    async upload(input) {
      return input.responseSchema.parse({});
    },
  };
}

const WORKSPACE = {
  id: 'ws1234567',
  name: 'Second Brain',
  slug: 'second-brain',
  role: 'OWNER' as const,
  memberCount: 1,
  isMemory: false,
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z',
};

describe('buildServerInstructions', () => {
  it('names the filing habit a client would otherwise have to guess', async () => {
    const instructions = await buildServerInstructions(
      clientWith({ '/api/workspaces': { workspaces: [] } }),
    );
    expect(instructions).toContain('exo_page_suggest_parent');
    expect(instructions).toContain('eine Ebene zu hoch');
  });

  it('carries an ALWAYS rule page into the handshake, in full', async () => {
    // The failure this pins: rule pages reached the built-in AI's system prompt
    // and no external client, so the deployment's own rules were invisible to
    // exactly the agents that file the most pages.
    const instructions = await buildServerInstructions(
      clientWith({
        '/api/workspaces': { workspaces: [WORKSPACE] },
        '/api/workspaces/ws1234567/ai-rules': {
          rules: [
            {
              documentId: 'rule123456',
              title: 'KI Regeln',
              mode: 'always',
              trigger: null,
              priority: 100,
            },
            {
              documentId: 'rule234567',
              title: 'Regel: Übersichtsseiten',
              mode: 'on_demand',
              trigger: 'Beim Anlegen von Übersichtsseiten',
              priority: 100,
            },
          ],
        },
        '/api/documents/rule123456/export/markdown': {
          documentId: 'rule123456',
          filename: 'ki-regeln.md',
          markdown:
            '---\ntitle: KI Regeln\nexocortexId: rule123456\n---\n\n' +
            'Schreib Seiten unter die tiefste passende Seite.',
          path: [],
          children: [],
        },
      }),
    );

    expect(instructions).toContain('Second Brain');
    expect(instructions).toContain('Schreib Seiten unter die tiefste passende Seite.');
    // The export's YAML header is dropped: ids and timestamps exist so a file
    // can be imported back, and they arrive first in the prompt.
    expect(instructions).not.toContain('exocortexId');
    // An ON_DEMAND rule contributes its trigger and the id to load it with,
    // never its body: that is the whole difference between the two modes.
    expect(instructions).toContain('Beim Anlegen von Übersichtsseiten');
    expect(instructions).toContain('rule234567');
  });

  it('keeps the handshake alive when the API cannot be read', async () => {
    const failing: ExocortexApiClient = {
      async request() {
        throw new Error('offline');
      },
      async upload(input) {
        return input.responseSchema.parse({});
      },
    };
    await expect(buildServerInstructions(failing)).resolves.toBe(BASE_INSTRUCTIONS);
  });
});
