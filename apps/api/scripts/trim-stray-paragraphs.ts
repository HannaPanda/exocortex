/**
 * Removes the empty paragraphs that collected at the top and bottom of pages.
 *
 * Until the editor waited for the stored state to arrive, opening a page built
 * Tiptap over a Yjs fragment that was still empty. Tiptap pushed its own
 * initial document -- one empty paragraph -- into it, and Yjs merged that
 * insert with the content that landed a moment later instead of discarding it.
 * Every visit left one paragraph behind, above or below the text depending on
 * where the client id sorted, which is why the pages that are read most had
 * grown the widest margins of blank lines.
 *
 * `CollaborationConnectionState.ready` stops new ones. This removes the ones
 * already stored, by deleting those runs from the binary Yjs state itself --
 * not by rewriting a page from its Markdown, which would be lossy for database
 * embeds and everything else Markdown cannot carry.
 *
 * Run it while nothing has the pages open. The collaboration server holds an
 * open document in memory and writes its own copy back on the next autosave,
 * which would restore what this removed (ADR-016). Straight after a deploy is
 * the moment: restarting the unit ends every session. The script is idempotent,
 * so a second run costs nothing and fixes whatever a session put back.
 *
 * Usage:
 *   pnpm --filter @exocortex/api documents:trim-paragraphs [-- --dry-run]
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

import { loadApiEnv } from '@exocortex/config';
import { QUEUE_NAMES } from '@exocortex/contracts';
import { createPrismaClient } from '@exocortex/database';
import { trimStrayParagraphs } from '@exocortex/editor';
import { createLogger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

/** How many content rows are loaded at once; the states are binary blobs. */
const BATCH_SIZE = 100;

async function main(): Promise<void> {
  const { values } = parseArgs({
    // pnpm forwards its own `--` separator; dropping it leaves `parseArgs`
    // looking at real flags only. Same trick as `delete-documents.ts`.
    args: process.argv.slice(2).filter((token) => token !== '--'),
    options: { 'dry-run': { type: 'boolean', default: false } },
  });
  const dryRun = values['dry-run'] === true;

  const env = loadApiEnv();
  const logger = createLogger({ name: 'trim-stray-paragraphs', level: 'warn', pretty: true });
  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  const queues = new QueueRegistry({ redisUrl: env.REDIS_URL, logger });

  let scanned = 0;
  let changed = 0;
  let removed = 0;

  try {
    let cursor: string | undefined;
    for (;;) {
      const rows = await prisma.documentContent.findMany({
        take: BATCH_SIZE,
        ...(cursor === undefined ? {} : { skip: 1, cursor: { documentId: cursor } }),
        orderBy: { documentId: 'asc' },
        select: {
          documentId: true,
          yjsState: true,
          schemaVersion: true,
          document: { select: { title: true, workspaceId: true } },
        },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]?.documentId;

      for (const row of rows) {
        scanned += 1;
        const trimmed = trimStrayParagraphs(new Uint8Array(row.yjsState));
        if (trimmed.yjsState === null) continue;

        changed += 1;
        removed += trimmed.leading + trimmed.trailing;
        console.log(
          `${row.documentId} "${row.document.title}": ` +
            `${trimmed.leading} above, ${trimmed.trailing} below`,
        );
        if (dryRun) continue;

        const now = new Date();
        await prisma.$transaction(async (tx) => {
          // The state as it was, so an operator can put a page back.
          await tx.documentSnapshot.create({
            data: {
              documentId: row.documentId,
              yjsState: row.yjsState,
              schemaVersion: row.schemaVersion,
              reason: 'MANUAL',
            },
          });
          await tx.documentContent.update({
            where: { documentId: row.documentId },
            data: { yjsState: Buffer.from(trimmed.yjsState), yjsUpdatedAt: now },
          });
        });

        // `materializedAt` stays behind `yjsUpdatedAt`, so the job below has
        // work to do: the derived Markdown, plain text and reference index all
        // still carry the paragraphs that are now gone.
        await queues.enqueue(QUEUE_NAMES.documentMaterialization, {
          correlationId: randomUUID(),
          documentId: row.documentId,
          workspaceId: row.document.workspaceId,
          yjsUpdatedAt: now.getTime(),
          reason: 'manual',
        });
      }
    }

    console.log(
      `\n${scanned} pages scanned, ${changed} with stray paragraphs, ` +
        `${removed} paragraphs ${dryRun ? 'would be removed' : 'removed'}.`,
    );
  } finally {
    await queues.close();
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Failed to trim paragraphs:', error instanceof Error ? error.message : error);
  process.exit(1);
});
