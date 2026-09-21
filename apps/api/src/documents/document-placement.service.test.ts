import { describe, expect, it } from 'vitest';

import { type WorkspaceAccessService } from '@exocortex/auth';
import { type PrismaClient, type SearchAdapter, type SearchHit } from '@exocortex/database';

import { DocumentPlacementService } from './document-placement.service';

/**
 * The ranking, on the shape of the tree that produced the bug (issue: pages
 * filed one level too high).
 *
 * "AI & Tools" holds eight sections; "Creative & Media" is one of them and
 * carries the media pages. A page about local music models belongs under the
 * section, and every piece of evidence for that is already in the workspace:
 * the pages closest to it all sit there.
 */

const ROWS = [
  { id: 'aitools123', parentId: null, title: 'AI & Tools', type: 'PAGE' as const },
  { id: 'creative12', parentId: 'aitools123', title: 'Creative & Media', type: 'PAGE' as const },
  { id: 'agents1234', parentId: 'aitools123', title: 'KI & Agenten', type: 'PAGE' as const },
  { id: 'fish123456', parentId: 'creative12', title: 'Fish Audio S2', type: 'PAGE' as const },
  { id: 'heygen1234', parentId: 'creative12', title: 'HeyGen', type: 'PAGE' as const },
  { id: 'minimax123', parentId: 'creative12', title: 'MiniMax H3', type: 'PAGE' as const },
  { id: 'docling123', parentId: 'agents1234', title: 'Docling', type: 'PAGE' as const },
];

function hit(documentId: string, rank: number): SearchHit {
  return {
    documentId,
    workspaceId: 'ws1234567',
    title: ROWS.find((row) => row.id === documentId)?.title ?? '',
    icon: null,
    iconColor: null,
    type: 'PAGE',
    snippet: '',
    section: null,
    rank,
    archivedAt: null,
    updatedAt: '2026-09-16T00:00:00.000Z',
  };
}

function serviceWith(hits: SearchHit[], rows = ROWS): DocumentPlacementService {
  const adapter = {
    id: 'hybrid',
    async search() {
      return hits;
    },
    async index() {},
    async remove() {},
    async healthCheck() {
      return true;
    },
  } satisfies SearchAdapter;

  const prisma = {
    document: {
      findMany: async () => rows,
      findFirst: async () => null,
    },
  } as unknown as PrismaClient;

  const access = {
    requireRole: async () => 'OWNER',
    // An unconfined credential: `documentIds === null` means "no narrowing",
    // which is what every case here is about (ADR-044).
    requireScopedRole: async () => ({ role: 'OWNER', documentIds: null }),
    requireDocumentContext: async (documentId: string) => ({
      document: {
        id: documentId,
        workspaceId: 'ws1234567',
        archivedAt: null,
        parentId: null,
        title: '',
        type: 'PAGE',
      },
      role: 'OWNER',
      workspaceId: 'ws1234567',
    }),
  } as unknown as WorkspaceAccessService;

  return new DocumentPlacementService(adapter, prisma, access);
}

describe('DocumentPlacementService', () => {
  it('prefers the section the neighbours live in over the level above it', async () => {
    const service = serviceWith([
      hit('fish123456', 0.71),
      hit('heygen1234', 0.64),
      hit('minimax123', 0.58),
      hit('docling123', 0.4),
    ]);

    const result = await service.suggestParent('ws1234567', 'user1234', {
      title: 'Lokale Musik-KI-Modelle',
      summary: 'ACE-Step, Gesang, lokal auf einer 16-GB-Karte',
    });

    expect(result.suggestions[0]?.parentId).toBe('creative12');
    expect(result.suggestions[0]?.title).toBe('Creative & Media');
    // The path is what tells a reader this is one level below where they were
    // about to file the page.
    expect(result.suggestions[0]?.path.map((entry) => entry.title)).toEqual(['AI & Tools']);
    expect(result.suggestions[0]?.childCount).toBe(3);
    expect(result.suggestions[0]?.matches.map((match) => match.title)).toContain('Fish Audio S2');
  });

  it('offers a section that is itself the nearest page, below its own children', async () => {
    // The neighbour is "Creative & Media" itself. Its parent is a candidate,
    // and so is it: a page can be filed under the section it resembles.
    const service = serviceWith([hit('creative12', 0.8)]);

    const result = await service.suggestParent('ws1234567', 'user1234', { title: 'Musik-KI' });

    expect(result.suggestions.map((suggestion) => suggestion.parentId)).toEqual([
      'aitools123',
      'creative12',
    ]);
  });

  it('never suggests a page its own subtree', async () => {
    const service = serviceWith([hit('creative12', 0.8), hit('fish123456', 0.7)]);

    const result = await service.suggestParent('ws1234567', 'user1234', {
      documentId: 'creative12',
      title: 'Creative & Media',
    });

    const offered = result.suggestions.map((suggestion) => suggestion.parentId);
    expect(offered).not.toContain('creative12');
  });

  it('answers with nothing rather than a guess when no page is close', async () => {
    const service = serviceWith([]);

    const result = await service.suggestParent('ws1234567', 'user1234', { title: 'Neuland' });

    expect(result.suggestions).toEqual([]);
    expect(result.adapter).toBe('hybrid');
  });
});
