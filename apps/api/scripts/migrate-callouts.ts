/**
 * Brings every stored page to schema version 6: the callouts of issue #306.
 *
 * A callout written before #306 carries one of five variants (`info`, `note`,
 * `success`, `warning`, `danger`). Version 6 stores what the box shows
 * instead: a symbol, a heading and a colour. `migrateCalloutsInYjsState`
 * rewrites those attributes in the binary Yjs state itself, element by
 * element, so the page keeps its history and nothing is rebuilt from its
 * Markdown (ADR-004/005). A page without a callout only has its version
 * raised.
 *
 * The collaboration server applies the same migration to every page it
 * loads (`afterLoadDocument`), which is what makes running this next to open
 * pages safe: a page somebody has open was loaded after the deploy that
 * brought this script, so it is migrated in that living copy too, and
 * whichever of the two writes last stores a migrated page. The script is
 * idempotent; a second run touches nothing.
 *
 * Every changed page gets a snapshot of its state before, like any other
 * write, so a single page can be put back from its history.
 *
 * Usage:
 *   pnpm --filter @exocortex/api documents:migrate-callouts [-- --dry-run]
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

import { loadApiEnv } from '@exocortex/config';
import { QUEUE_NAMES } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { EXOCORTEX_SCHEMA_VERSION, migrateCalloutsInYjsState } from '@exocortex/editor';
import { createLogger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

/** How many content rows are loaded at once; the states are binary blobs. */
const BATCH_SIZE = 100;

interface ContentRow {
  documentId: string;
  yjsState: Uint8Array;
  yjsUpdatedAt: Date;
  schemaVersion: number;
  document: { title: string; workspaceId: string };
}

type RowOutcome = { kind: 'raised' } | { kind: 'skipped' } | { kind: 'migrated'; callouts: number };

/**
 * Migrates one stored page.
 *
 * Every write is conditional on the row still being what was read: a page the
 * collaboration server stored in between is left alone, because writing the
 * migrated *old* state over it would drop what was typed since. That page was
 * loaded by the new build and is migrated there; a second run raises its
 * version if the server has not stored it yet.
 */
async function migrateRow(
  prisma: PrismaClient,
  queues: QueueRegistry,
  row: ContentRow,
  dryRun: boolean,
): Promise<RowOutcome> {
  const unchanged = {
    documentId: row.documentId,
    schemaVersion: row.schemaVersion,
    yjsUpdatedAt: row.yjsUpdatedAt,
  };
  const result = migrateCalloutsInYjsState(new Uint8Array(row.yjsState));
  // Bound to a local before the guard: a narrowing on a property does not
  // survive into the transaction callback below.
  const migratedState = result.yjsState;

  if (migratedState === null) {
    if (dryRun) return { kind: 'raised' };
    // Only the version: there is nothing to change in the content.
    const { count } = await prisma.documentContent.updateMany({
      where: unchanged,
      data: { schemaVersion: EXOCORTEX_SCHEMA_VERSION },
    });
    return count === 1 ? { kind: 'raised' } : { kind: 'skipped' };
  }

  console.log(`${row.documentId} "${row.document.title}": ${result.migrated} callouts`);
  if (dryRun) return { kind: 'migrated', callouts: result.migrated };

  const now = new Date();
  const written = await prisma.$transaction(async (tx) => {
    const { count } = await tx.documentContent.updateMany({
      where: unchanged,
      data: {
        yjsState: Buffer.from(migratedState),
        schemaVersion: EXOCORTEX_SCHEMA_VERSION,
        yjsUpdatedAt: now,
      },
    });
    if (count !== 1) return false;
    // The state as it was, so a single page can be put back from its history.
    await tx.documentSnapshot.create({
      data: {
        documentId: row.documentId,
        yjsState: Buffer.from(row.yjsState),
        schemaVersion: row.schemaVersion,
        reason: 'MANUAL',
      },
    });
    return true;
  });
  if (!written) return { kind: 'skipped' };

  // The derived Markdown, plain text and JSON still name the variant.
  await queues.enqueue(QUEUE_NAMES.documentMaterialization, {
    correlationId: randomUUID(),
    documentId: row.documentId,
    workspaceId: row.document.workspaceId,
    yjsUpdatedAt: now.getTime(),
    reason: 'manual',
  });
  return { kind: 'migrated', callouts: result.migrated };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    // pnpm forwards its own `--` separator; same trick as `delete-documents.ts`.
    args: process.argv.slice(2).filter((token) => token !== '--'),
    options: { 'dry-run': { type: 'boolean', default: false } },
  });
  const dryRun = values['dry-run'] === true;

  const env = loadApiEnv();
  const logger = createLogger({ name: 'migrate-callouts', level: 'warn', pretty: true });
  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  const queues = new QueueRegistry({ redisUrl: env.REDIS_URL, logger });

  let scanned = 0;
  let pages = 0;
  let callouts = 0;
  let raised = 0;
  let skipped = 0;

  try {
    let cursor: string | undefined;
    for (;;) {
      const rows = await prisma.documentContent.findMany({
        take: BATCH_SIZE,
        // A plain `gt` instead of Prisma's cursor: the rows already done no
        // longer match the filter, and a cursor with `skip: 1` would then skip
        // the first row that still does.
        where: {
          schemaVersion: { lt: EXOCORTEX_SCHEMA_VERSION },
          ...(cursor === undefined ? {} : { documentId: { gt: cursor } }),
        },
        orderBy: { documentId: 'asc' },
        select: {
          documentId: true,
          yjsState: true,
          yjsUpdatedAt: true,
          schemaVersion: true,
          document: { select: { title: true, workspaceId: true } },
        },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]?.documentId;

      for (const row of rows) {
        scanned += 1;
        const outcome = await migrateRow(prisma, queues, row, dryRun);
        if (outcome.kind === 'raised') raised += 1;
        if (outcome.kind === 'skipped') skipped += 1;
        if (outcome.kind === 'migrated') {
          pages += 1;
          callouts += outcome.callouts;
        }
      }
    }

    console.log(
      `\n${scanned} pages below schema ${EXOCORTEX_SCHEMA_VERSION}: ` +
        `${pages} with ${callouts} callouts ${dryRun ? 'would be migrated' : 'migrated'}, ` +
        `${raised} ${dryRun ? 'would only be raised' : 'only raised'} to the new version, ` +
        `${skipped} skipped because they changed meanwhile (run again).`,
    );
  } finally {
    await queues.close();
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Failed to migrate callouts:', error instanceof Error ? error.message : error);
  process.exit(1);
});
