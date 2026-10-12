import { describe, expect, it } from 'vitest';

import { type KnowledgeMapResponse } from '@exocortex/contracts';

import { renderKnowledgeMap } from './links.js';

const NODE = {
  type: 'PAGE' as const,
  icon: null,
  iconColor: null,
  degree: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  editedAt: '2026-10-01T00:00:00.000Z',
};

const MAP: KnowledgeMapResponse = {
  workspaceId: 'ws1234567890',
  generatedAt: '2026-10-12T00:00:00.000Z',
  semantic: 'partial',
  nodes: [
    {
      ...NODE,
      id: 'technik00001',
      kind: 'page',
      title: 'Technik',
      parentId: null,
      rootId: 'technik00001',
    },
    {
      ...NODE,
      id: 'nginx0000001',
      kind: 'page',
      title: 'nginx',
      parentId: 'technik00001',
      rootId: 'technik00001',
    },
    {
      ...NODE,
      id: 'certbot00001',
      kind: 'page',
      title: 'certbot',
      parentId: 'technik00001',
      rootId: 'technik00001',
    },
    {
      ...NODE,
      id: 'einsam000001',
      kind: 'page',
      title: 'Einsame Notiz',
      parentId: null,
      rootId: 'einsam000001',
    },
    {
      ...NODE,
      id: 'fpb200000001',
      kind: 'entity',
      title: 'fpb2',
      parentId: null,
      rootId: 'fpb200000001',
    },
  ],
  edges: [
    { source: 'technik00001', target: 'nginx0000001', kind: 'tree', weight: 1 },
    { source: 'technik00001', target: 'certbot00001', kind: 'tree', weight: 1 },
    { source: 'nginx0000001', target: 'fpb200000001', kind: 'entity', weight: 0.5 },
    { source: 'nginx0000001', target: 'certbot00001', kind: 'similar', weight: 0.8 },
  ],
};

describe('renderKnowledgeMap', () => {
  const text = renderKnowledgeMap(MAP);

  it('counts the points and every kind of line, and says why similarities may be missing', () => {
    expect(text).toContain('5 Seiten, davon 1 Entitäten');
    expect(text).toContain('1 Ähnlichkeiten ohne Verweis');
    expect(text).toContain('noch keinen Suchvektor');
  });

  it('ranks hubs without the tree, so a big folder is not mistaken for a hub', () => {
    const hubs = text.split('Knotenpunkte')[1]?.split('\n\n')[0] ?? '';
    expect(hubs.split('\n')[1]).toContain('nginx [id: nginx0000001]: 2');
    expect(hubs).not.toContain('Technik [id');
  });

  it('names the pages that stand alone and the pairs that resemble each other unlinked', () => {
    expect(text).toContain('Ohne Verbindung außer dem Seitenbaum: 2 Seiten');
    expect(text).toContain('Einsame Notiz [id: einsam000001]');
    expect(text).toContain('nginx [id: nginx0000001] ↔ certbot [id: certbot00001]');
  });
});
