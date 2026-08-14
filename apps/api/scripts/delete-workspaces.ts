/**
 * Workspace deletion, for the operator.
 *
 * Deleting a workspace is not something the application offers: it destroys
 * every page, every version and every uploaded file underneath it, and nothing
 * in the product needs it. What does need it is housekeeping — the browser
 * suite creates a workspace per run and would otherwise fill the deployment
 * with hundreds of them, and an administrator has no other way to undo one
 * created by mistake.
 *
 * So this is an operator task run from a terminal, and like
 * `import-obsidian.ts` it talks to `@exocortex/database` and
 * `@exocortex/storage` directly rather than through the REST API. The reason
 * is the same and it is not laziness: there is no REST endpoint to call,
 * deliberately, because a route that erases a workspace is a route that can be
 * reached by a session.
 *
 * The order matters. Stored objects go first, while the rows that name them
 * still exist: dropping the rows first would strand every uploaded file in the
 * bucket with nothing left to say which workspace it belonged to. A failed
 * object delete is reported and does not stop the run, because a bucket that
 * kept one file is a smaller problem than a half-deleted workspace.
 *
 * Usage:
 *   pnpm --filter @exocortex/api workspaces:delete -- --id <id> [--id <id> …]
 *   pnpm --filter @exocortex/api workspaces:delete -- --ids-file <path>
 *   pnpm --filter @exocortex/api workspaces:delete -- --id <id> --dry-run
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { loadApiEnv } from '@exocortex/config';
import { createPrismaClient } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';
import { S3ObjectStorage } from '@exocortex/storage';

interface Options {
  ids: string[];
  dryRun: boolean;
}

async function parseOptions(): Promise<Options> {
  const { values } = parseArgs({
    // pnpm forwards its own `--` separator; dropping it leaves `parseArgs`
    // looking at real flags only. Same trick as `import-obsidian.ts`.
    args: process.argv.slice(2).filter((token) => token !== '--'),
    options: {
      id: { type: 'string', multiple: true },
      'ids-file': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const ids = [...(values.id ?? [])];
  if (values['ids-file'] !== undefined) {
    const content = await readFile(values['ids-file'], 'utf8');
    // One id per line, blanks and `#` comments ignored, so the file can be
    // appended to by a test run and still be read by a human.
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith('#')) ids.push(trimmed);
    }
  }

  return { ids: [...new Set(ids)], dryRun: values['dry-run'] === true };
}

async function main(): Promise<void> {
  const options = await parseOptions();
  if (options.ids.length === 0) {
    console.error('Nothing to do: pass --id <workspaceId> or --ids-file <path>.');
    process.exitCode = 1;
    return;
  }

  const env = loadApiEnv();
  const logger = createLogger({ name: 'delete-workspaces', level: 'warn', pretty: true });
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

  let deleted = 0;
  let missing = 0;
  let objectsRemoved = 0;
  let objectsFailed = 0;

  try {
    for (const workspaceId of options.ids) {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, name: true, _count: { select: { documents: true } } },
      });
      if (workspace === null) {
        missing += 1;
        console.log(`skip   ${workspaceId} (does not exist)`);
        continue;
      }

      // Soft-deleted rows included: their objects are still in the bucket.
      const attachments = await prisma.attachment.findMany({
        where: { workspaceId },
        select: { storageKey: true, previewKey: true },
      });
      const keys = attachments.flatMap((attachment) =>
        [attachment.storageKey, attachment.previewKey].filter((key): key is string => key !== null),
      );

      if (options.dryRun) {
        console.log(
          `would delete ${workspace.id} "${workspace.name}" ` +
            `(${workspace._count.documents} pages, ${keys.length} objects)`,
        );
        continue;
      }

      for (const key of keys) {
        try {
          await storage.deleteObject({ key });
          objectsRemoved += 1;
        } catch (error) {
          objectsFailed += 1;
          console.warn(
            `  object ${key}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Everything below the workspace cascades from this one row.
      await prisma.workspace.delete({ where: { id: workspaceId } });
      deleted += 1;
      console.log(
        `deleted ${workspace.id} "${workspace.name}" ` +
          `(${workspace._count.documents} pages, ${keys.length} objects)`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    options.dryRun
      ? `\nDry run: ${options.ids.length} workspaces inspected, nothing deleted.`
      : `\n${deleted} deleted, ${missing} already gone, ` +
          `${objectsRemoved} objects removed, ${objectsFailed} objects failed.`,
  );
}

void main().catch((error: unknown) => {
  console.error('Failed to delete workspaces:', error);
  process.exit(1);
});
