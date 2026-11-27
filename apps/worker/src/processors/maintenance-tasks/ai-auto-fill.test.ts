import { describe, expect, it } from 'vitest';

import { type PrismaClient } from '@exocortex/database';
import { type QueueRegistry } from '@exocortex/queue';

import { type AiAutoFillEvent, scheduleAiAutoFills } from './ai-auto-fill';

/**
 * A row, its database and the database's self-filling columns, with no
 * database behind them. What is tested is the decision: does this change of
 * this page call for an automatic fill, and what does the queued job say.
 */
function harness(input: {
  /** The page's parent type; null for a page without a parent. */
  parentType?: 'COLLECTION' | 'PAGE' | null;
  /** The `autoFill` values of the parent's columns. */
  columns?: ('OFF' | 'ON_CREATE' | 'ON_CHANGE')[];
  enabled?: boolean;
  /** A job still waiting under the row's id, with the trigger it carries. */
  waiting?: 'created' | 'changed';
}) {
  const queued: { jobId: string; payload: Record<string, unknown> }[] = [];
  const parentType = input.parentType === undefined ? 'COLLECTION' : input.parentType;
  const columns = input.columns ?? ['ON_CREATE'];

  const prisma = {
    document: {
      findFirst: async (query: {
        select: {
          parent: {
            select: {
              databaseProperties: { where: { ai: { autoFill: { in: string[] } } } };
            };
          };
        };
      }) => {
        const wanted = query.select.parent.select.databaseProperties.where.ai.autoFill.in;
        return parentType === null
          ? { parentId: null, parent: null }
          : {
              parentId: 'database-1',
              parent: {
                type: parentType,
                databaseProperties: columns
                  .filter((value) => wanted.includes(value))
                  .map((_, index) => ({ id: `column-${String(index)}` })),
              },
            };
      },
    },
  } as unknown as PrismaClient;

  const queues = {
    getQueue: () => ({
      getJob: async () =>
        input.waiting === undefined
          ? undefined
          : {
              data: { kind: 'auto', trigger: input.waiting },
              isDelayed: async () => true,
            },
    }),
    enqueueDebounced: async (
      _name: string,
      payload: Record<string, unknown>,
      options: { jobId: string },
    ) => {
      queued.push({ jobId: options.jobId, payload });
      return options.jobId;
    },
  } as unknown as QueueRegistry;

  return {
    context: { prisma, queues, enabledFor: async () => input.enabled ?? true },
    queued,
  };
}

function event(type: string): AiAutoFillEvent {
  return {
    workspaceId: 'workspace-1',
    type,
    payload: { documentId: 'row-1' },
    correlationId: 'correlation-1',
  };
}

describe('scheduleAiAutoFills (issue #237, ADR-099)', () => {
  it('queues one debounced job for a new row of a database with a self-filling column', async () => {
    const { context, queued } = harness({});
    expect(await scheduleAiAutoFills(context, event('document.created'))).toBe(true);
    expect(queued).toEqual([
      {
        jobId: 'ai-fill-auto-row-1',
        payload: {
          kind: 'auto',
          correlationId: 'correlation-1',
          workspaceId: 'workspace-1',
          databaseId: 'database-1',
          rowId: 'row-1',
          trigger: 'created',
        },
      },
    ]);
  });

  it('wakes a column filling only new rows on a new row, never on a change', async () => {
    const { context, queued } = harness({ columns: ['ON_CREATE'] });
    expect(await scheduleAiAutoFills(context, event('document.materialized'))).toBe(false);
    expect(queued).toHaveLength(0);
  });

  it('wakes a column filling on change for a changed text or title', async () => {
    for (const type of ['document.materialized', 'document.updated', 'document.content.replaced']) {
      const { context, queued } = harness({ columns: ['ON_CHANGE'] });
      expect(await scheduleAiAutoFills(context, event(type))).toBe(true);
      expect(queued[0]?.payload.trigger).toBe('changed');
    }
  });

  it('keeps a row new when it is changed before its job ran', async () => {
    const { context, queued } = harness({ columns: ['ON_CHANGE'], waiting: 'created' });
    await scheduleAiAutoFills(context, event('document.materialized'));
    expect(queued[0]?.payload.trigger).toBe('created');
  });

  it('does nothing for a value write, a page outside a database, a column switched off or AI off', async () => {
    const cases: [Parameters<typeof harness>[0], string][] = [
      [{}, 'database.row.updated'],
      [{ parentType: 'PAGE' }, 'document.created'],
      [{ parentType: null }, 'document.created'],
      [{ columns: ['OFF'] }, 'document.created'],
      [{ enabled: false }, 'document.created'],
    ];
    for (const [setup, type] of cases) {
      const { context, queued } = harness(setup);
      expect(await scheduleAiAutoFills(context, event(type))).toBe(false);
      expect(queued).toHaveLength(0);
    }
  });
});
