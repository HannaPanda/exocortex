import { describe, expect, it, vi } from 'vitest';

import {
  type DatabaseFilterGroup,
  type SavedQueryDefinition,
  savedQueryDefinitionSchema,
} from '@exocortex/contracts';

import { type PrismaClient } from './client';
import { buildDerivedSchema, buildPropertyMap, type DatabaseQueryScope } from './database-derived';
import {
  compileStructuralFilter,
  resolveDateRange,
  runSavedQuery,
  type SavedQueryRunDeps,
  SavedQueryScopeError,
} from './saved-query';
import { type SearchAdapter, type SearchHit } from './search';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function definition(partial: Record<string, unknown> = {}): SavedQueryDefinition {
  return savedQueryDefinitionSchema.parse(partial);
}

const SELECT = { id: 'prop_status', type: 'SELECT' as const };
const scope: DatabaseQueryScope = {
  properties: buildPropertyMap([SELECT]),
  schema: buildDerivedSchema([SELECT]),
};

describe('resolveDateRange', () => {
  it('counts a relative window back from now, so a saved query keeps moving', () => {
    const { from, to } = resolveDateRange(
      { withinDays: 30, after: null, before: null },
      new Date('2026-09-19T12:00:00.000Z'),
    );
    expect(from?.toISOString()).toBe('2026-08-20T12:00:00.000Z');
    expect(to).toBeNull();
  });

  it('lets the relative window win over an absolute lower bound', () => {
    const { from } = resolveDateRange(
      { withinDays: 1, after: '2020-01-01T00:00:00.000Z', before: null },
      NOW,
    );
    expect(from?.toISOString()).toBe('2026-09-18T12:00:00.000Z');
  });

  it('reads both absolute bounds when there is no relative one', () => {
    const { from, to } = resolveDateRange(
      { withinDays: null, after: '2026-01-01T00:00:00.000Z', before: '2026-02-01T00:00:00.000Z' },
      NOW,
    );
    expect(from?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(to?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('compileStructuralFilter', () => {
  it('always scopes to the workspace and hides archived pages', () => {
    const sql = compileStructuralFilter(
      { workspaceId: 'ws1', definition: definition() },
      undefined,
    );
    expect(sql.sql).toContain('document."workspaceId" = ?');
    expect(sql.sql).toContain('document."archivedAt" IS NULL');
    expect(sql.values).toEqual(['ws1']);
  });

  it('keeps archived pages when asked, and only then', () => {
    const sql = compileStructuralFilter(
      { workspaceId: 'ws1', definition: definition({ includeArchived: true }) },
      undefined,
    );
    expect(sql.sql).not.toContain('archivedAt');
  });

  it('resolves a subtree at query time rather than storing its members', () => {
    const sql = compileStructuralFilter(
      { workspaceId: 'ws1', definition: definition({ underDocumentId: 'doc_root' }) },
      undefined,
    );
    expect(sql.sql).toContain('WITH RECURSIVE');
    expect(sql.values).toContain('doc_root');
  });

  it('asks for every named entity under ALL and for any of them under ANY', () => {
    const all = compileStructuralFilter(
      {
        workspaceId: 'ws1',
        definition: definition({
          entityIds: ['entity_one', 'entity_two', 'entity_two'],
          entityMatch: 'ALL',
        }),
      },
      undefined,
    );
    // Two distinct entities named three times is still a target of two.
    expect(all.values).toContain(2);

    const any = compileStructuralFilter(
      {
        workspaceId: 'ws1',
        definition: definition({ entityIds: ['entity_one'], entityMatch: 'ANY' }),
      },
      undefined,
    );
    expect(any.sql).toContain('EXISTS');
  });

  it('turns a relative window into a bound parameter, not into SQL', () => {
    const sql = compileStructuralFilter(
      { workspaceId: 'ws1', definition: definition({ updated: { withinDays: 7 } }), now: NOW },
      undefined,
    );
    expect(sql.sql).toContain('document."updatedAt" >=');
    expect(sql.values).toContainEqual(new Date('2026-09-12T12:00:00.000Z'));
  });

  it('compiles a property filter with the database view engine', () => {
    const propertyFilter: DatabaseFilterGroup = {
      combinator: 'and',
      conditions: [{ propertyId: SELECT.id, operator: 'equals', value: 'Offen' }],
    };
    const sql = compileStructuralFilter(
      {
        workspaceId: 'ws1',
        definition: definition({ collectionId: 'collection_one', propertyFilter }),
      },
      scope,
    );
    expect(sql.sql).toContain('document."parentId" = ');
    expect(sql.values).toContain('Offen');
  });

  it('refuses a property filter without the schema that gives its ids meaning', () => {
    const propertyFilter: DatabaseFilterGroup = {
      combinator: 'and',
      conditions: [{ propertyId: SELECT.id, operator: 'equals', value: 'Offen' }],
    };
    expect(() =>
      compileStructuralFilter(
        {
          workspaceId: 'ws1',
          definition: definition({ collectionId: 'collection_one', propertyFilter }),
        },
        undefined,
      ),
    ).toThrow(SavedQueryScopeError);
  });
});

function hit(documentId: string, rank: number): SearchHit {
  return {
    documentId,
    workspaceId: 'ws1',
    title: documentId,
    icon: null,
    iconColor: null,
    type: 'PAGE',
    snippet: `<mark>${documentId}</mark>`,
    rank,
    archivedAt: null,
    updatedAt: '2026-09-19T00:00:00.000Z',
  };
}

function row(documentId: string, updatedAt: string) {
  return {
    documentId,
    workspaceId: 'ws1',
    parentId: null,
    title: documentId,
    icon: null,
    iconColor: null,
    type: 'PAGE' as const,
    snippet: 'aus dem Index',
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date(updatedAt),
  };
}

function adapter(id: string, hits: SearchHit[]): SearchAdapter {
  return {
    id,
    search: vi.fn(async () => hits),
    index: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    healthCheck: vi.fn(async () => true),
  };
}

function deps(rows: unknown[], hits: SearchHit[] = []): SavedQueryRunDeps {
  return {
    prisma: { $queryRaw: vi.fn(async () => rows) } as unknown as PrismaClient,
    hybrid: adapter('postgres+pgvector', hits),
    keyword: adapter('postgres', hits),
  };
}

describe('runSavedQuery', () => {
  it('answers a structural query from SQL alone and names no adapter', async () => {
    const result = await runSavedQuery(deps([row('a', '2026-09-01T00:00:00.000Z')]), {
      workspaceId: 'ws1',
      definition: definition({ limit: 5 }),
    });
    expect(result.adapter).toBe('none');
    expect(result.rows.map((entry) => entry.documentId)).toEqual(['a']);
    expect(result.truncated).toBe(false);
  });

  it('says so when the limit cut the answer short', async () => {
    const rows = [row('a', '2026-09-01T00:00:00.000Z'), row('b', '2026-09-02T00:00:00.000Z')];
    const result = await runSavedQuery(deps(rows), {
      workspaceId: 'ws1',
      definition: definition({ limit: 1 }),
    });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('keeps the adapter order for RELEVANCE and drops what the filter rejected', async () => {
    const hits = [hit('a', 0.9), hit('b', 0.5), hit('c', 0.1)];
    // SQL answers with only two of the three candidates: `b` is outside the
    // structural half of the query.
    const runDeps = deps(
      [row('c', '2026-01-01T00:00:00.000Z'), row('a', '2026-01-01T00:00:00.000Z')],
      hits,
    );
    const result = await runSavedQuery(runDeps, {
      workspaceId: 'ws1',
      definition: definition({ text: 'steuer', limit: 10 }),
    });
    expect(result.rows.map((entry) => entry.documentId)).toEqual(['a', 'c']);
    expect(result.adapter).toBe('postgres+pgvector');
    // The adapter's snippet wins: it is the one that knows what matched.
    expect(result.rows[0]?.snippet).toBe('<mark>a</mark>');
  });

  it('uses the full-text adapter alone for KEYWORD, so no model is called', async () => {
    const runDeps = deps([row('a', '2026-01-01T00:00:00.000Z')], [hit('a', 1)]);
    const result = await runSavedQuery(runDeps, {
      workspaceId: 'ws1',
      definition: definition({ text: 'steuer', textMode: 'KEYWORD' }),
    });
    expect(result.adapter).toBe('postgres');
    expect(runDeps.hybrid.search).not.toHaveBeenCalled();
    expect(runDeps.keyword.search).toHaveBeenCalled();
  });

  it('reorders a text query when the reader asked for something other than relevance', async () => {
    const hits = [hit('old', 0.9), hit('new', 0.1)];
    const runDeps = deps(
      [row('old', '2026-01-01T00:00:00.000Z'), row('new', '2026-09-01T00:00:00.000Z')],
      hits,
    );
    const result = await runSavedQuery(runDeps, {
      workspaceId: 'ws1',
      definition: definition({ text: 'steuer', sort: 'UPDATED_DESC' }),
    });
    expect(result.rows.map((entry) => entry.documentId)).toEqual(['new', 'old']);
  });

  it('does not query the database at all when nothing matched the words', async () => {
    const runDeps = deps([], []);
    const result = await runSavedQuery(runDeps, {
      workspaceId: 'ws1',
      definition: definition({ text: 'steuer' }),
    });
    expect(result.rows).toEqual([]);
    expect(runDeps.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('overrides the stored limit when a block asks for fewer rows', async () => {
    const rows = [
      row('a', '2026-09-03T00:00:00.000Z'),
      row('b', '2026-09-02T00:00:00.000Z'),
      row('c', '2026-09-01T00:00:00.000Z'),
    ];
    const result = await runSavedQuery(deps(rows), {
      workspaceId: 'ws1',
      definition: definition({ limit: 50 }),
      limit: 2,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
