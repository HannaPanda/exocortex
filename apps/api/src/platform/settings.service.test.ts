import { describe, expect, it } from 'vitest';

import { settingsSchema } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { AdminService } from '../admin/admin.service';
import { type OutboxService } from '../common/outbox.service';

import { SettingsService } from './settings.service';

/**
 * A stored setting row that does not validate, all the way to the admin area.
 *
 * `resolveSettings` drops such a row and boots on the default, which is right --
 * one hand-edited row must not stop a process from starting. The failure this
 * pins is what came after: the drop was reported into the log and nowhere else,
 * so the settings form displayed the default while the table held something else
 * and nothing on screen mentioned it (issue #27).
 *
 * Deliberately not against the real database, unlike its neighbours in this
 * suite: `DATABASE_URL` here is the live deployment's, and writing an invalid
 * `setting` row into it would change how the running installation behaves for as
 * long as the test held it there. Only `setting.findMany` is needed, so it is
 * faked.
 */
const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const outbox = {} as unknown as OutboxService;

function serviceReading(rows: readonly { key: string; value: unknown }[]): SettingsService {
  const prisma = {
    setting: { findMany: () => Promise.resolve(rows) },
  } as unknown as PrismaClient;
  return new SettingsService(prisma, logger, outbox);
}

const defaults = settingsSchema.parse({});

describe('SettingsService', () => {
  it('reports nothing invalid for a table of good rows', async () => {
    const service = serviceReading([{ key: 'ai.maxToolIterations', value: 200 }]);

    expect((await service.get())['ai.maxToolIterations']).toBe(200);
    expect(await service.invalidKeys()).toEqual([]);
  });

  it('names a row it had to ignore, and serves the default in its place', async () => {
    const service = serviceReading([
      // Above the schema's ceiling of 1000 (issue #28), so it is refused.
      { key: 'ai.maxToolIterations', value: 5_000 },
      { key: 'ai.enabled', value: false },
    ]);

    expect(await service.invalidKeys()).toEqual(['ai.maxToolIterations']);
    const settings = await service.get();
    expect(settings['ai.maxToolIterations']).toBe(defaults['ai.maxToolIterations']);
    // The rest of the table still applies: one bad row is not a bad table.
    expect(settings['ai.enabled']).toBe(false);
  });

  it('answers both questions from one read', async () => {
    let reads = 0;
    const prisma = {
      setting: {
        findMany: () => {
          reads += 1;
          return Promise.resolve([{ key: 'mcp.maxSearchResults', value: 0 }]);
        },
      },
    } as unknown as PrismaClient;
    const service = new SettingsService(prisma, logger, outbox);

    await service.get();
    await service.invalidKeys();

    // Both go through the same cache. A second query per page load would be the
    // kind of cost that gets this reverted rather than fixed.
    expect(reads).toBe(1);
  });

  it('hands the ignored rows to the admin area with the settings', async () => {
    const settings = serviceReading([{ key: 'ai.pdfMaxBytes', value: -1 }]);
    // `AdminService` only reaches Prisma in the methods this test does not call.
    const admin = new AdminService({} as unknown as PrismaClient, logger, settings);

    const response = await admin.getSettings();

    expect(response.invalidKeys).toEqual(['ai.pdfMaxBytes']);
    expect(response.settings['ai.pdfMaxBytes']).toBe(defaults['ai.pdfMaxBytes']);
  });
});
