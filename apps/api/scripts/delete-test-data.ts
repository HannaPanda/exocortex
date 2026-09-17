/**
 * Sweeps up what an interrupted test run left behind.
 *
 * The third cleanup in this directory, and the one for the case the other two
 * cannot cover. `delete-workspaces.ts` and `delete-documents.ts` are told what
 * to remove by a run that finished. The integration suites clean up after
 * themselves too, in `afterAll` — but `afterAll` does not run when the process
 * is killed, and that is exactly when the mess is made: 21 workspaces had piled
 * up by 2026-08-12, in `Collab`/`Worker` pairs created in the same second,
 * because two packages test in parallel and an interrupt takes both.
 *
 * So this one is not told anything. It recognises test data by the only marker
 * that cannot be anything else: the accounts live at `@exocortex.test`, and
 * `.test` is reserved by RFC 6761 precisely so that it can never be a real
 * address. A workspace whose members are all such accounts was made by a test
 * run and by nothing else. A name prefix would have been the obvious rule and
 * the wrong one — it needs updating whenever a suite invents a name, and it
 * would happily match a real workspace somebody called "Docs".
 *
 * Two things it will not do. It never touches a workspace with even one real
 * member, and it never touches anything younger than `--older-than` (two hours
 * by default), so a suite running right now — in another terminal, or in the
 * turbo task that is about to start — cannot have the ground taken out from
 * under it.
 *
 * Usage:
 *   pnpm --filter @exocortex/api test-data:prune -- [--older-than 2] [--dry-run]
 *
 * Wired into the repository's `pnpm test` so it happens on its own, and *before*
 * the suites rather than after: after is the moment a killed run never reaches.
 */
import { parseArgs } from 'node:util';

import { loadApiEnv } from '@exocortex/config';
import { createPrismaClient } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';
import { S3ObjectStorage } from '@exocortex/storage';

/** Reserved by RFC 6761: no real account can ever be here. */
const TEST_EMAIL_SUFFIX = '@exocortex.test';

const DEFAULT_OLDER_THAN_HOURS = 2;

interface Options {
  olderThanHours: number;
  dryRun: boolean;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    // pnpm forwards its own `--` separator; dropping it leaves `parseArgs`
    // looking at real flags only. Same trick as the scripts next door.
    args: process.argv.slice(2).filter((token) => token !== '--'),
    options: {
      'older-than': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const raw = values['older-than'];
  const olderThanHours = raw === undefined ? DEFAULT_OLDER_THAN_HOURS : Number(raw);
  if (!Number.isFinite(olderThanHours) || olderThanHours < 0) {
    throw new Error(`--older-than must be a number of hours, got ${String(raw)}`);
  }

  return { olderThanHours, dryRun: values['dry-run'] === true };
}

async function main(): Promise<void> {
  const options = parseOptions();
  const env = loadApiEnv();
  const logger = createLogger({ name: 'delete-test-data', level: 'warn', pretty: true });
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

  const cutoff = new Date(Date.now() - options.olderThanHours * 60 * 60 * 1000);

  try {
    /**
     * The verification keys `mcp.service.test.ts` publishes, first.
     *
     * Not a workspace, and the only row this sweep removes that is not reached
     * through one -- but a signing key in a shared table is the one leftover
     * worth being thorough about. The rows are minted already expired, so
     * better-auth never signs with them, and their private half only ever
     * existed in a test process; still, a key nobody can account for should not
     * outlive the run that made it.
     */
    const staleKeys = await prisma.jwks.deleteMany({
      where: { id: { startsWith: 'jwks-test-' }, createdAt: { lt: cutoff } },
    });
    if (staleKeys.count > 0) {
      console.log(`${staleKeys.count} leftover test signing keys removed.`);
    }

    const candidates = await prisma.workspace.findMany({
      where: {
        createdAt: { lt: cutoff },
        members: { some: { user: { email: { endsWith: TEST_EMAIL_SUFFIX } } } },
      },
      select: {
        id: true,
        name: true,
        _count: { select: { documents: true } },
        members: { select: { user: { select: { email: true } } } },
      },
    });

    // One real member is enough to make a workspace somebody's, whoever else is
    // in it.
    const workspaces = candidates.filter((workspace) =>
      workspace.members.every((member) => member.user.email.endsWith(TEST_EMAIL_SUFFIX)),
    );
    const spared = candidates.length - workspaces.length;
    if (spared > 0) {
      console.log(`${spared} workspaces have a real member and are left alone.`);
    }
    if (workspaces.length === 0) {
      console.log(`Nothing to prune (test data older than ${cutoff.toISOString()}).`);
      return;
    }

    const workspaceIds = workspaces.map((workspace) => workspace.id);
    const attachments = await prisma.attachment.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { storageKey: true, previewKey: true },
    });
    const keys = attachments.flatMap((attachment) =>
      [attachment.storageKey, attachment.previewKey].filter((key): key is string => key !== null),
    );

    for (const workspace of workspaces) {
      console.log(
        `${options.dryRun ? 'would prune' : 'prune'} ${workspace.id} "${workspace.name}" ` +
          `(${workspace._count.documents} pages)`,
      );
    }

    if (options.dryRun) {
      const users = await prisma.user.count({ where: { email: { endsWith: TEST_EMAIL_SUFFIX } } });
      console.log(
        `\nDry run: ${workspaces.length} workspaces, ${keys.length} objects, ` +
          `up to ${users} test accounts. Nothing deleted.`,
      );
      return;
    }

    let objectsRemoved = 0;
    let objectsFailed = 0;
    // Objects first, while the rows that name them still exist.
    for (const key of keys) {
      try {
        await storage.deleteObject({ key });
        objectsRemoved += 1;
      } catch (error) {
        objectsFailed += 1;
        console.warn(`  object ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const removed = await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });

    /**
     * The accounts last, and only the ones that are now unreferenced.
     *
     * `Document.createdById` is a required reference, so an account that still
     * authored something cannot go — and must not: that would mean a real
     * workspace is holding a page a test account wrote, which is a thing to look
     * at rather than to delete around.
     */
    const orphans = await prisma.user.findMany({
      where: {
        email: { endsWith: TEST_EMAIL_SUFFIX },
        createdAt: { lt: cutoff },
        memberships: { none: {} },
        createdDocuments: { none: {} },
      },
      select: { id: true },
    });
    const removedUsers = await prisma.user.deleteMany({
      where: { id: { in: orphans.map((user) => user.id) } },
    });
    const stubborn = await prisma.user.count({
      where: { email: { endsWith: TEST_EMAIL_SUFFIX }, createdAt: { lt: cutoff } },
    });

    console.log(
      `\n${removed.count} workspaces pruned, ${removedUsers.count} test accounts, ` +
        `${objectsRemoved} objects removed, ${objectsFailed} objects failed` +
        (stubborn > 0 ? `, ${stubborn} accounts kept (they still own content)` : ''),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  // Housekeeping must never be the reason a test run does not start, so this
  // reports and exits clean. `pnpm test` chains it with `&&`.
  console.warn(
    'Could not prune test data:',
    error instanceof Error ? error.message : String(error),
  );
});
