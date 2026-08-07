import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import { pageBacklinksTool } from './links.js';

interface RecordedCall {
  method: string;
  path: string;
}

function createFakeClient(response: unknown): {
  client: ExocortexApiClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: ExocortexApiClient = {
    async request(input) {
      calls.push({ method: input.method, path: input.path });
      return input.responseSchema.parse(response);
    },
    async upload(input) {
      return input.responseSchema.parse(response);
    },
  };
  return { client, calls };
}

const RESPONSE = {
  documentId: 'doc1234567',
  pending: false,
  incoming: [
    {
      id: 'link000001',
      kind: 'wikiMark',
      targetTitle: 'Deployment',
      blockId: null,
      context: 'Der Betrieb steht in Deployment beschrieben.',
      source: {
        id: 'src1234567',
        title: 'Betrieb',
        type: 'PAGE',
        icon: null,
        iconColor: null,
        archivedAt: null,
      },
    },
  ],
  outgoing: [
    {
      id: 'link000002',
      kind: 'mention',
      targetTitle: 'Gibt es nicht',
      blockId: null,
      context: 'Siehe Gibt es nicht.',
      target: null,
    },
  ],
};

describe('pageBacklinksTool', () => {
  it('reads the link endpoint and renders both directions', async () => {
    const { client, calls } = createFakeClient(RESPONSE);

    const result = await pageBacklinksTool.run(client, { documentId: 'doc1234567' });

    expect(calls).toEqual([{ method: 'GET', path: '/api/documents/doc1234567/links' }]);
    expect(result.text).toContain('Verweise auf diese Seite (1)');
    expect(result.text).toContain('Betrieb (id: src1234567, Wiki-Link)');
    expect(result.text).toContain('Der Betrieb steht in Deployment beschrieben.');
    expect(result.text).toContain('davon 1 unaufgelöst');
    expect(result.text).toContain('nicht auflösbar');
  });

  it('restricts the output to one direction on request', async () => {
    const { client } = createFakeClient(RESPONSE);
    const result = await pageBacklinksTool.run(client, {
      documentId: 'doc1234567',
      direction: 'incoming',
    });
    expect(result.text).toContain('Verweise auf diese Seite');
    expect(result.text).not.toContain('Diese Seite verweist auf');
  });

  it('says so when nothing points at the page', async () => {
    const { client } = createFakeClient({ ...RESPONSE, incoming: [], outgoing: [] });
    const result = await pageBacklinksTool.run(client, { documentId: 'doc1234567' });
    expect(result.text).toContain('Keine Seite verweist auf diese Seite.');
    expect(result.text).toContain('Diese Seite verweist auf keine andere Seite.');
  });

  it('distinguishes "nothing there" from "not indexed yet"', async () => {
    const { client } = createFakeClient({
      ...RESPONSE,
      incoming: [],
      outgoing: [],
      pending: true,
    });
    const result = await pageBacklinksTool.run(client, { documentId: 'doc1234567' });
    expect(result.text).toContain('noch nicht erfasst');
  });

  it('is a read-only tool on both surfaces', () => {
    expect(pageBacklinksTool.mutating).toBe(false);
    expect([...pageBacklinksTool.surfaces].sort()).toEqual(['ai', 'mcp']);
  });
});
