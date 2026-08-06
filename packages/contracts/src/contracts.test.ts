import { describe, expect, it } from 'vitest';

import {
  databaseFilterGroupSchema,
  databaseFilterOperatorSchema,
  databasePropertyTypeSchema,
  databaseViewSchema,
  updateDatabaseViewRequestSchema,
} from './database-views';
import { createDocumentRequestSchema, moveDocumentRequestSchema } from './documents';
import { API_ERROR_CODES,API_ERROR_STATUS } from './errors';
import { applicationEventSchema, workspaceRoom } from './events';
import { JOB_SCHEMAS, QUEUE_NAMES } from './jobs';
import { WORKSPACE_ROLE_RANK } from './primitives';

describe('document contracts', () => {
  it('applies German defaults for new pages', () => {
    const parsed = createDocumentRequestSchema.parse({});
    expect(parsed.title).toBe('Unbenannte Seite');
    expect(parsed.type).toBe('PAGE');
  });

  it('rejects an unknown document type', () => {
    expect(() => createDocumentRequestSchema.parse({ type: 'DATABASE' })).toThrow();
  });

  it('requires an explicit parentId on move (null means root)', () => {
    expect(() => moveDocumentRequestSchema.parse({})).toThrow();
    expect(moveDocumentRequestSchema.parse({ parentId: null }).parentId).toBeNull();
  });
});

describe('application events', () => {
  it('validates a job progress event', () => {
    const event = applicationEventSchema.parse({
      type: 'job.progress',
      workspaceId: 'workspace_abcdefgh',
      emittedAt: '2026-08-04T10:00:00.000Z',
      correlationId: 'corr-1',
      payload: {
        jobId: '42',
        queue: 'document-materialization',
        progress: 50,
        label: 'Seite wird verarbeitet',
      },
    });
    expect(event.type).toBe('job.progress');
  });

  it('rejects an unknown event type', () => {
    expect(() =>
      applicationEventSchema.parse({
        type: 'document.exploded',
        workspaceId: 'workspace_abcdefgh',
        emittedAt: '2026-08-04T10:00:00.000Z',
        correlationId: 'c',
        payload: {},
      }),
    ).toThrow();
  });

  it('derives room names server-side', () => {
    expect(workspaceRoom('workspace_1')).toBe('workspace:workspace_1');
  });
});

describe('job payloads', () => {
  it('has a schema for every queue', () => {
    for (const queue of Object.values(QUEUE_NAMES)) {
      expect(JOB_SCHEMAS[queue]).toBeDefined();
    }
  });

  it('rejects a materialization job without a correlation id', () => {
    expect(() =>
      JOB_SCHEMAS[QUEUE_NAMES.documentMaterialization].parse({
        documentId: 'document_abcdefgh',
        workspaceId: 'workspace_abcdefgh',
        yjsUpdatedAt: 1,
        reason: 'import',
      }),
    ).toThrow();
  });
});

describe('error contract', () => {
  it('maps every error code to an HTTP status', () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('workspace roles', () => {
  it('ranks roles from guest to owner', () => {
    expect(WORKSPACE_ROLE_RANK.GUEST).toBeLessThan(WORKSPACE_ROLE_RANK.MEMBER);
    expect(WORKSPACE_ROLE_RANK.MEMBER).toBeLessThan(WORKSPACE_ROLE_RANK.ADMIN);
    expect(WORKSPACE_ROLE_RANK.ADMIN).toBeLessThan(WORKSPACE_ROLE_RANK.OWNER);
  });
});

describe('database contracts', () => {
  it('accepts every declared property type, including the reserved ones', () => {
    for (const type of ['TEXT', 'RELATION', 'ROLLUP', 'FORMULA']) {
      expect(databasePropertyTypeSchema.parse(type)).toBe(type);
    }
  });

  it('rejects an unknown property type', () => {
    expect(() => databasePropertyTypeSchema.parse('DATABASE')).toThrow();
  });

  it('rejects an unknown filter operator', () => {
    expect(() => databaseFilterOperatorSchema.parse('starts_with')).toThrow();
  });

  it('round-trips a nested AND/OR filter group', () => {
    const group = {
      combinator: 'or',
      conditions: [
        { propertyId: 'property_abcdefgh', operator: 'equals', value: 'Erledigt' },
        {
          combinator: 'and',
          conditions: [
            { propertyId: 'property_ijklmnop', operator: 'is_not_empty' },
            { propertyId: 'property_qrstuvwx', operator: 'on_or_before', value: '2026-12-31' },
          ],
        },
      ],
    };
    const parsed = databaseFilterGroupSchema.parse(group);
    expect(parsed).toEqual(group);
  });

  it('rejects a filter group deeper than the combinator/condition shape allows', () => {
    expect(() =>
      databaseFilterGroupSchema.parse({ combinator: 'xor', conditions: [] }),
    ).toThrow();
  });

  it('parses a full TABLE view with defaults applied to config', () => {
    const view = databaseViewSchema.parse({
      id: 'view_abcdefgh',
      documentId: 'document_abcdefgh',
      type: 'TABLE',
      name: 'Alle Einträge',
      orderKey: 'V',
      filters: { combinator: 'and', conditions: [] },
      sorts: [],
      groupByPropertyId: null,
      config: {},
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    });
    expect(view.config.visibleProperties).toEqual([]);
  });

  it('leaves a config field the caller did not mention absent', () => {
    // The update endpoint merges `config` shallowly onto the stored one, so a
    // default filled in here would reset `rowHeight` instead of keeping it.
    const parsed = updateDatabaseViewRequestSchema.parse({
      config: { columnWidths: { title: 320 } },
    });
    expect(parsed.config).toEqual({ columnWidths: { title: 320 } });
    expect(parsed.config).not.toHaveProperty('rowHeight');
    expect(parsed.config).not.toHaveProperty('visibleProperties');
  });

  it('rejects a column width outside the allowed bounds', () => {
    expect(() =>
      updateDatabaseViewRequestSchema.parse({ config: { columnWidths: { title: 4000 } } }),
    ).toThrow();
  });
});
