/**
 * Obsidian vault importer.
 *
 * Imports a folder tree of Markdown notes (Johanna's "Second Brain" vault)
 * into an Exocortex workspace: vault folders become root-and-nested `PAGE`
 * documents, notes become `PAGE` documents underneath them, and `[[wikilinks]]`
 * become internal `wiki:` links resolved by note title.
 *
 * This is an operator task run from a terminal by whoever administers the
 * deployment, not a user-facing feature, so it talks to `@exocortex/database`
 * and `@exocortex/queue` directly instead of going through the REST API or the
 * MCP tool catalogue (which would mean creating 609 documents one HTTP request
 * at a time). It deliberately mirrors the transaction shape of
 * `apps/api/src/documents/document-markdown.service.ts`: Markdown is parsed
 * once into a canonical Yjs state via `markdownToYjsState`
 * (`@exocortex/editor`), and every derived representation (ProseMirror JSON,
 * plain text, re-serialized Markdown) is either written alongside it or left
 * to the materialization job — Markdown is never treated as canonical
 * (CLAUDE.md rule 5, ADR-007).
 *
 * Idempotency: the schema is frozen (no import-id column may be added), so a
 * document's identity is the triple `(workspaceId, parentId, title)`. Every
 * create goes through a find-first on that triple. Re-running the script is
 * therefore safe and produces no duplicates; it does mean that renaming a
 * folder or note in the vault and re-running creates a second page rather
 * than moving the first one — the conservative behaviour for a script that
 * has no way to know "this used to be called X".
 *
 * Usage:
 *   pnpm --filter @exocortex/api import:obsidian -- \
 *     --vault "/path/to/vault" --email user@example.com \
 *     --workspace "Second Brain" [--dry-run] [--limit 20] [--verify-only]
 */
import { parseArgs } from 'node:util';

import { loadApiEnv } from '@exocortex/config';
import { createPrismaClient, type Prisma, type PrismaClient } from '@exocortex/database';
import {
  EXOCORTEX_SCHEMA_VERSION,
  type Frontmatter,
  markdownToYjsState,
  parseFrontmatter,
  serializeFrontmatter,
} from '@exocortex/editor';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import {
  buildBasenameIndex,
  buildTitleIndex,
  comparePath,
  renderFrontmatterHeader,
  rewriteWikilinks,
  type RewriteWikilinksResult,
  scanVault,
} from './import-obsidian/vault';
import { printVerification, runVerification } from './import-obsidian/verify';
import {
  createFolderPages,
  createNoteStubs,
  enqueueMaterialization,
  type ImportTarget,
} from './import-obsidian/write-passes';

/** Re-exported so `import-obsidian.test.ts` keeps one import path. */
export {
  buildBasenameIndex,
  buildTitleIndex,
  comparePath,
  extractTitle,
  normalizeWikiTarget,
  renderFrontmatterHeader,
  rewriteWikilinks,
  type VaultNote,
} from './import-obsidian/vault';

const PROGRESS_INTERVAL = 25;
const UNRESOLVED_SAMPLE_LIMIT = 20;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  vault: string;
  email: string;
  workspace: string;
  dryRun: boolean;
  limit: number | null;
  verifyOnly: boolean;
}

function printUsageAndExit(message?: string): never {
  if (message !== undefined) console.error(message);
  console.error(
    'Usage: import:obsidian -- --vault <path> --email <email> --workspace <name> ' +
      '[--dry-run] [--limit N] [--verify-only]',
  );
  process.exit(1);
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  // `pnpm run <script> -- --flag value` forwards the literal `--` separator
  // into the script's own argv (unlike `npm run`, which swallows it). Strip
  // it so `node:util`'s `parseArgs` sees only real flags.
  const { values } = parseArgs({
    args: argv.filter((token) => token !== '--'),
    options: {
      vault: { type: 'string' },
      email: { type: 'string' },
      workspace: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      limit: { type: 'string' },
      'verify-only': { type: 'boolean', default: false },
    },
  });

  if (values.vault === undefined) printUsageAndExit('Missing required flag --vault');
  if (values.email === undefined) printUsageAndExit('Missing required flag --email');
  if (values.workspace === undefined) printUsageAndExit('Missing required flag --workspace');

  let limit: number | null = null;
  if (values.limit !== undefined) {
    const parsed = Number.parseInt(values.limit, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      printUsageAndExit(`Invalid --limit value "${values.limit}": must be a positive integer`);
    }
    limit = parsed;
  }

  return {
    vault: values.vault,
    email: values.email,
    workspace: values.workspace,
    dryRun: values['dry-run'] === true,
    limit,
    verifyOnly: values['verify-only'] === true,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested in import-obsidian.test.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Workspace slug (duplicated in miniature from
// apps/api/src/workspaces/workspaces.service.ts: importing NestJS-decorated
// application services from a standalone script is not worth the coupling
// for six lines of string transformation).
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return base.length >= 2 ? base : 'arbeitsbereich';
}

async function findFreeWorkspaceSlug(prisma: PrismaClient, desired: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? desired : `${desired}-${attempt + 1}`;
    const existing = await prisma.workspace.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (existing === null) return candidate;
  }
  throw new Error(`Could not find a free workspace slug for "${desired}"`);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

interface ImportStats {
  workspaceId: string;
  workspaceCreated: boolean;
  foldersCreated: number;
  foldersExisting: number;
  notesCreated: number;
  notesUpdated: number;
  notesFailed: number;
  notesTotal: number;
  wikilinksTotal: number;
  wikilinksResolved: number;
  wikilinksUnresolved: number;
  ambiguousBasenames: Map<string, string[]>;
  unresolvedSamples: string[];
  skipped: Map<string, number>;
  materializationEnqueued: number;
}

async function resolveWorkspace(
  prisma: PrismaClient,
  userId: string,
  workspaceName: string,
  dryRun: boolean,
): Promise<{ workspaceId: string; created: boolean }> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId, workspace: { name: workspaceName, archivedAt: null } },
    include: { workspace: { select: { id: true } } },
  });
  if (membership !== null) {
    return { workspaceId: membership.workspace.id, created: false };
  }

  if (dryRun) {
    return { workspaceId: `dry-run:workspace:${workspaceName}`, created: true };
  }

  const slug = await findFreeWorkspaceSlug(prisma, slugify(workspaceName));
  const workspace = await prisma.$transaction(async (tx) => {
    const created = await tx.workspace.create({ data: { name: workspaceName, slug } });
    await tx.workspaceMember.create({
      data: { workspaceId: created.id, userId, role: 'OWNER' },
    });
    return created;
  });
  return { workspaceId: workspace.id, created: true };
}

async function importVault(context: {
  prisma: PrismaClient;
  queues: QueueRegistry | null;
  logger: Logger;
  args: CliArgs;
  userId: string;
  workspaceId: string;
  workspaceCreated: boolean;
}): Promise<ImportStats> {
  const { prisma, queues, logger, args, userId, workspaceId, workspaceCreated } = context;
  const { notes: allNotes, skipped } = await scanVault(args.vault);
  const notes = args.limit !== null ? allNotes.slice(0, args.limit) : allNotes;

  // Pass 2: title index + basename index, before anything is written.
  const titleOf = buildTitleIndex(notes);
  const { byBasename, ambiguousBasenames } = buildBasenameIndex(notes);

  const orderKeyCache = new Map<string, string | null>();

  // Pass 3 and 4A: folder pages, then note stubs (ids first, so a wikilink can
  // be rewritten once every note it might point at already has one).
  const target: ImportTarget = {
    prisma,
    workspaceId,
    userId,
    dryRun: args.dryRun,
    orderKeyCache,
  };
  const folders = await createFolderPages(target, notes);
  const stubs = await createNoteStubs(target, notes, folders.folderPageId, titleOf);
  const notePageId = stubs.notePageId;
  const foldersCreated = folders.created;
  const foldersExisting = folders.existing;
  const notesCreated = stubs.created;

  // Pass 4, phase B: transform Markdown and write content.
  let notesUpdated = 0;
  let notesFailed = 0;
  let wikilinksTotal = 0;
  let wikilinksResolved = 0;
  let wikilinksUnresolved = 0;
  const unresolvedSamples: string[] = [];
  const materializationJobs: Array<{ documentId: string }> = [];

  for (const [index, note] of notes.entries()) {
    if ((index + 1) % PROGRESS_INTERVAL === 0) {
      console.error(`Imported ${index + 1}/${notes.length} notes…`);
    }

    const documentId = notePageId.get(note.relativePath);
    if (documentId === undefined) continue;

    let frontmatter: Frontmatter;
    let rewritten: RewriteWikilinksResult;
    try {
      const parsed = parseFrontmatter(note.raw);
      frontmatter = parsed.frontmatter;
      rewritten = rewriteWikilinks(parsed.body, byBasename, titleOf);
    } catch (error) {
      notesFailed += 1;
      logger.warn('Failed to parse frontmatter, skipping content write', {
        documentId,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    wikilinksTotal += rewritten.totalFound;
    wikilinksResolved += rewritten.resolved;
    wikilinksUnresolved += rewritten.unresolvedTargets.length;
    for (const target of rewritten.unresolvedTargets) {
      if (unresolvedSamples.length < UNRESOLVED_SAMPLE_LIMIT) unresolvedSamples.push(target);
    }

    if (args.dryRun || documentId.startsWith('dry-run:')) continue;

    const finalMarkdown = `${serializeFrontmatter(frontmatter)}${renderFrontmatterHeader(frontmatter)}${rewritten.text}`;

    let imported: ReturnType<typeof markdownToYjsState>;
    let contentMarkdown = finalMarkdown;
    try {
      imported = markdownToYjsState(finalMarkdown);
    } catch (error) {
      // The page (created in phase A) must not end up with *no* content row
      // at all — that leaves a half-created, unopenable page in the tree,
      // worse than a page that is openable but visibly needs attention. Fall
      // back to an empty, valid document instead of skipping the write; the
      // note is still counted as `failed` so the report and the operator
      // know it needs a manual look.
      notesFailed += 1;
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('markdownToYjsState failed, writing an empty placeholder instead', {
        relativePath: note.relativePath,
        documentId,
        reason,
      });
      contentMarkdown = `> [!warning] Import fehlgeschlagen\n> Diese Seite konnte beim Obsidian-Import nicht automatisch umgewandelt werden (${reason}). Bitte manuell aus der Originaldatei "${note.relativePath}" nachtragen.\n`;
      imported = markdownToYjsState(contentMarkdown);
    }

    try {
      const materializedAt = new Date();
      // Explicit, strictly later than `materializedAt` so the enqueued
      // materialization job never sees `materializedAt >= yjsUpdatedAt` and
      // skips: that comparison is how the job normally avoids redundant work,
      // but here it would also skip enqueuing the chained search-indexing job.
      const yjsUpdatedAt = new Date(materializedAt.getTime() + 1);

      const [existingContent, existingImportSnapshot] = await Promise.all([
        prisma.documentContent.findUnique({ where: { documentId }, select: { documentId: true } }),
        prisma.documentSnapshot.findFirst({
          where: { documentId, reason: 'IMPORT' },
          select: { id: true },
        }),
      ]);

      await prisma.$transaction(async (tx) => {
        const contentData = {
          yjsState: Buffer.from(imported.yjsState),
          schemaVersion: EXOCORTEX_SCHEMA_VERSION,
          proseMirrorJson: imported.proseMirrorJson as unknown as Prisma.InputJsonObject,
          plainText: imported.plainText,
          markdown: contentMarkdown,
          materializedAt,
          yjsUpdatedAt,
        };
        await tx.documentContent.upsert({
          where: { documentId },
          create: { documentId, ...contentData },
          update: contentData,
        });

        if (existingImportSnapshot === null) {
          await tx.documentSnapshot.create({
            data: {
              documentId,
              yjsState: Buffer.from(imported.yjsState),
              schemaVersion: EXOCORTEX_SCHEMA_VERSION,
              createdById: userId,
              reason: 'IMPORT',
            },
          });
        }
      });

      if (existingContent !== null) notesUpdated += 1;
      materializationJobs.push({ documentId });
    } catch (error) {
      notesFailed += 1;
      logger.warn('Failed to write document content', {
        relativePath: note.relativePath,
        documentId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const materializationEnqueued = await enqueueMaterialization(
    queues,
    workspaceId,
    materializationJobs.map((job) => job.documentId),
  );

  return {
    workspaceId,
    workspaceCreated,
    foldersCreated,
    foldersExisting,
    notesCreated,
    notesUpdated,
    notesFailed,
    notesTotal: notes.length,
    wikilinksTotal,
    wikilinksResolved,
    wikilinksUnresolved,
    ambiguousBasenames,
    unresolvedSamples,
    skipped,
    materializationEnqueued,
  };
}

function printSummary(args: CliArgs, stats: ImportStats, durationMs: number): void {
  const skippedList =
    stats.skipped.size === 0
      ? 'none'
      : [...stats.skipped.entries()]
          .sort((a, b) => comparePath(a[0], b[0]))
          .map(([ext, count]) => `${ext}: ${count}`)
          .join(', ');
  const skippedTotal = [...stats.skipped.values()].reduce((sum, n) => sum + n, 0);

  console.log('Vault:              ' + args.vault);
  console.log(
    `Workspace:          ${args.workspace} (${stats.workspaceId})  [${stats.workspaceCreated ? 'created' : 'existing'}]`,
  );
  console.log(
    `Folders:            ${stats.foldersCreated + stats.foldersExisting} pages  ` +
      `(${stats.foldersCreated} created, ${stats.foldersExisting} reused)`,
  );
  console.log(
    `Notes:              ${stats.notesTotal} pages  ` +
      `(${stats.notesCreated} created, ${stats.notesUpdated} updated, ${stats.notesFailed} failed)`,
  );
  console.log(
    `Wikilinks:          ${stats.wikilinksTotal} found, ${stats.wikilinksResolved} resolved, ` +
      `${stats.wikilinksUnresolved} unresolved`,
  );
  console.log(
    `Ambiguous titles:   ${stats.ambiguousBasenames.size}  (resolved to the shortest path)`,
  );
  console.log(`Skipped files:      ${skippedTotal}  (${skippedList})`);
  console.log(`Materialization:    ${stats.materializationEnqueued} jobs enqueued`);
  console.log(`Duration:           ${(durationMs / 1000).toFixed(1)} s`);

  if (stats.unresolvedSamples.length > 0) {
    console.error(`Unresolved wikilink targets (first ${stats.unresolvedSamples.length}):`);
    for (const target of stats.unresolvedSamples) console.error(`  - ${target}`);
  }
  if (stats.ambiguousBasenames.size > 0) {
    console.error('Ambiguous basenames:');
    for (const [key, paths] of stats.ambiguousBasenames) {
      console.error(`  - "${key}": ${paths.join(', ')}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  loadApiEnv();
  const prisma = createPrismaClient();
  const logger = createLogger({ name: 'import-obsidian' });
  const startedAt = Date.now();
  let queues: QueueRegistry | null = null;

  try {
    const user = await prisma.user.findUnique({
      where: { email: args.email },
      select: { id: true },
    });
    if (user === null) {
      console.error(`No user found with email "${args.email}". Aborting.`);
      process.exitCode = 1;
      return;
    }

    const { workspaceId, created: workspaceCreated } = await resolveWorkspace(
      prisma,
      user.id,
      args.workspace,
      args.dryRun,
    );
    logger.info(workspaceCreated ? 'Workspace will be created' : 'Reusing existing workspace', {
      workspaceId,
      email: args.email,
    });

    if (args.verifyOnly) {
      const result = await runVerification(prisma, args.vault, workspaceId, 0);
      printVerification(result);
      process.exitCode = result.allPassed ? 0 : 1;
      return;
    }

    if (!args.dryRun && process.env.REDIS_URL !== undefined) {
      queues = new QueueRegistry({ redisUrl: process.env.REDIS_URL, logger });
    }

    const stats = await importVault({
      prisma,
      queues,
      logger,
      args,
      userId: user.id,
      workspaceId,
      workspaceCreated,
    });
    printSummary(args, stats, Date.now() - startedAt);

    if (!args.dryRun) {
      const result = await runVerification(prisma, args.vault, workspaceId, stats.notesFailed);
      printVerification(result);
      process.exitCode = result.allPassed ? 0 : 1;
    }
  } finally {
    if (queues !== null) await queues.close();
    await prisma.$disconnect();
  }
}

// Only run when this file is executed directly (`tsx scripts/import-obsidian.ts`),
// not when its pure helpers are imported by the unit tests. Vitest sets
// `process.env.VITEST` in every test worker, which is a more portable guard
// here than `import.meta.url` — this project's `tsconfig`s target CommonJS
// output for `apps/api`, where TypeScript rejects `import.meta` outright.
if (process.env.VITEST === undefined) {
  void main().catch((error: unknown) => {
    console.error('Obsidian import failed:', error);
    process.exitCode = 1;
  });
}
