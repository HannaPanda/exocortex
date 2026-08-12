/**
 * Pruning the pages a test run left in a shared workspace, for the operator.
 *
 * `delete-workspaces.ts` next door removes the workspaces the browser suite
 * creates. It cannot help with the pages the suite makes inside the *seeded*
 * workspace it signs in to, because that workspace has to survive the run — and
 * those pages accumulate: 1,271 of them by 2026-08-12, against six that belong
 * there, which is a page tree nobody can read and a suite that gets slower with
 * every run.
 *
 * Same shape and the same reasons as the workspace script: an operator task run
 * from a terminal, straight against `@exocortex/database` and
 * `@exocortex/storage`, because there is deliberately no REST route that erases
 * pages outright — a route that can do this is a route a session can reach.
 *
 * The cut is a timestamp rather than a list of ids or a pattern in the title.
 * A title pattern would need updating every time a test invents a new name, and
 * would quietly spare the ones that do not match; "everything created after the
 * run started" needs no maintenance and cannot miss a page.
 *
 * Order matters, exactly as it does for workspaces: stored objects go first,
 * while the rows that name them still exist.
 *
 * Usage:
 *   pnpm --filter @exocortex/api documents:delete -- \
 *     --workspace <id> --created-after 2026-08-12T20:00:00Z [--dry-run]
 */
import { parseArgs } from 'node:util';

import { loadApiEnv } from '@exocortex/config';
import { createPrismaClient } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';
import { S3ObjectStorage } from '@exocortex/storage';

interface Options {
  workspaceId: string;
  createdAfter: Date;
  dryRun: boolean;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    // pnpm forwards its own `--` separator; dropping it leaves `parseArgs`
    // looking at real flags only. Same trick as `delete-workspaces.ts`.
    args: process.argv.slice(2).filter((token) => token !== '--'),
    options: {
      workspace: { type: 'string' },
      'created-after': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const workspaceId = values.workspace;
  const createdAfterRaw = values['created-after'];
  if (workspaceId === undefined || createdAfterRaw === undefined) {
    throw new Error('Both --workspace <id> and --created-after <iso timestamp> are required');
  }

  const createdAfter = new Date(createdAfterRaw);
  if (Number.isNaN(createdAfter.getTime())) {
    throw new Error(`Not a timestamp: ${createdAfterRaw}`);
  }
  // No default and no open end on purpose. This deletes pages outright; the two
  // things that bound what it touches both have to be typed out.
  if (createdAfter.getTime() > Date.now()) {
    throw new Error('--created-after is in the future, which would delete nothing');
  }

  return { workspaceId, createdAfter, dryRun: values['dry-run'] === true };
}

async function main(): Promise<void> {
  const options = parseOptions();
  const env = loadApiEnv();
  const logger = createLogger({ name: 'delete-documents', level: 'warn', pretty: true });
  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  const storage = new S3ObjectStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    logger,
  });

  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: options.workspaceId },
      select: { id: true, name: true, _count: { select: { documents: true } } },
    });
    if (workspace === null) {
      throw new Error(`No workspace with id ${options.workspaceId}`);
    }

    const where = { workspaceId: workspace.id, createdAt: { gte: options.createdAfter } };

    // Archived pages included: they are rows and objects like any other, and
    // "in the trash" is not "gone".
    const documents = await prisma.document.findMany({ where, select: { id: true } });
    const attachments = await prisma.attachment.findMany({
      where: { workspaceId: workspace.id, createdAt: { gte: options.createdAfter } },
      select: { storageKey: true, previewKey: true },
    });
    const keys = attachments.flatMap((attachment) =>
      [attachment.storageKey, attachment.previewKey].filter((key): key is string => key !== null),
    );

    const survivors = workspace._count.documents - documents.length;
    console.log(
      `${workspace.id} "${workspace.name}": ${documents.length} of ` +
        `${workspace._count.documents} pages created after ` +
        `${options.createdAfter.toISOString()}, ${keys.length} objects, ` +
        `${survivors} pages older than the cut and kept`,
    );

    if (options.dryRun) {
      console.log('\nDry run: nothing deleted.');
      return;
    }
    if (documents.length === 0) return;

    let objectsRemoved = 0;
    let objectsFailed = 0;
    for (const key of keys) {
      try {
        await storage.deleteObject({ key });
        objectsRemoved += 1;
      } catch (error) {
        // A bucket that kept one file is a smaller problem than a half-deleted
        // page tree, so this reports and carries on.
        objectsFailed += 1;
        console.warn(`  object ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Subpages cascade from their parent, so some of these rows are already
    // gone by the time the statement reaches them. `deleteMany` does not mind,
    // and its answer is what actually went.
    const removed = await prisma.document.deleteMany({ where });
    // Attachments do not: `Attachment.documentId` is `SetNull`, so an upload
    // whose page just vanished would stay behind as a row pointing at nothing.
    const removedAttachments = await prisma.attachment.deleteMany({
      where: { workspaceId: workspace.id, createdAt: { gte: options.createdAfter } },
    });

    console.log(
      `\n${removed.count} pages deleted, ${removedAttachments.count} attachments, ` +
        `${objectsRemoved} objects removed, ${objectsFailed} objects failed.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Failed to delete documents:', error instanceof Error ? error.message : error);
  process.exit(1);
});
