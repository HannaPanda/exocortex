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
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { loadApiEnv } from '@exocortex/config';
import { QUEUE_NAMES } from '@exocortex/contracts';
import {
  createPrismaClient,
  generateOrderKey,
  PostgresSearchAdapter,
  type Prisma,
  type PrismaClient,
} from '@exocortex/database';
import {
  createEmptyYjsState,
  EXOCORTEX_SCHEMA_VERSION,
  type Frontmatter,
  markdownToYjsState,
  parseFrontmatter,
  parseMarkdown,
  serializeFrontmatter,
  yjsStateToMarkdown,
} from '@exocortex/editor';
import { createCorrelationId, createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

const MATERIALIZATION_CHUNK_SIZE = 50;
const MATERIALIZATION_CHUNK_PAUSE_MS = 100;
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

export interface VaultNote {
  /** Path relative to the vault root, POSIX separators. Stable identity. */
  relativePath: string;
  /** Path segments without the filename, e.g. ['Kreativ', 'Rezepte']. */
  folders: readonly string[];
  /** Filename without `.md`. This is what wikilinks resolve against. */
  basename: string;
  raw: string;
}

/** Deterministic byte-order-ish string comparison used for every sort in this script. */
export function comparePath(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Normalizes a wikilink target for lookup: case, whitespace, a leading `./`.
 * Obsidian resolves `[[Target]]` case-insensitively against the filename, so
 * every lookup key in this script goes through this function.
 */
export function normalizeWikiTarget(target: string): string {
  return target.trim().replace(/^\.\//, '').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Builds the basename -> relativePath lookup wikilinks resolve against.
 *
 * A basename that occurs more than once is ambiguous: `byBasename` resolves it
 * to the shortest `relativePath` (deterministic tie-break: shorter, then byte
 * order), and every path that shares the basename is recorded in
 * `ambiguousBasenames` for the final report.
 */
export function buildBasenameIndex(notes: readonly VaultNote[]): {
  byBasename: Map<string, string>;
  ambiguousBasenames: Map<string, string[]>;
} {
  const candidates = new Map<string, string[]>();
  for (const note of notes) {
    const key = normalizeWikiTarget(note.basename);
    const list = candidates.get(key);
    if (list === undefined) candidates.set(key, [note.relativePath]);
    else list.push(note.relativePath);
  }

  const byBasename = new Map<string, string>();
  const ambiguousBasenames = new Map<string, string[]>();
  for (const [key, paths] of candidates) {
    const shortestFirst = [...paths].sort((a, b) => a.length - b.length || comparePath(a, b));
    byBasename.set(key, shortestFirst[0] as string);
    if (paths.length > 1) {
      ambiguousBasenames.set(key, [...paths].sort(comparePath));
    }
  }
  return { byBasename, ambiguousBasenames };
}

/**
 * Title precedence: frontmatter `title` > first `# Heading` > basename.
 *
 * `parseMarkdown` (from `@exocortex/editor`) already implements exactly the
 * first two rules; this only adds the basename fallback and never throws (a
 * note with unparsable frontmatter still gets a title).
 */
export function extractTitle(raw: string, basename: string): string {
  try {
    const { title } = parseMarkdown(raw, { assignBlockIds: false });
    return title ?? basename;
  } catch {
    return basename;
  }
}

/**
 * Builds the `relativePath -> title` index used for identity
 * `(workspaceId, parentId, title)` and for rendering resolved wikilink
 * labels.
 *
 * Identity has no room for anything but the triple (the schema is frozen), so
 * two genuinely different notes that happen to extract the same title under
 * the same folder — for example two independently saved bookmarks whose first
 * heading is identical text — would otherwise collide: the second note's
 * find-first lookup would find the first note's freshly created stub and
 * silently overwrite its content instead of getting a page of its own. This
 * vault has three such pairs (verified against the live vault before writing
 * this). Processing notes in their stable sorted order and appending
 * " (2)", " (3)", ... to every title after the first occurrence within the
 * same folder keeps the identity scheme intact, is fully deterministic, and
 * never loses a note.
 */
export function buildTitleIndex(notes: readonly VaultNote[]): Map<string, string> {
  const titleOf = new Map<string, string>();
  const usedTitlesByParent = new Map<string, Set<string>>();

  for (const note of notes) {
    const baseTitle = extractTitle(note.raw, note.basename);
    const parentPath = note.folders.join('/');
    const used = usedTitlesByParent.get(parentPath) ?? new Set<string>();

    let title = baseTitle;
    let suffix = 2;
    while (used.has(title)) {
      title = `${baseTitle} (${suffix})`;
      suffix += 1;
    }

    used.add(title);
    usedTitlesByParent.set(parentPath, used);
    titleOf.set(note.relativePath, title);
  }

  return titleOf;
}

/**
 * Renders the two known frontmatter shapes (bookmark, recipe) as a leading
 * Exocortex callout, so the information a wikilink cannot carry is still
 * visible on the page. Returns `''` when nothing recognisable is present.
 *
 * Deliberately narrow: this only renders the fields the brief asks for
 * (source/quelle, saved_at, portionen, tags). `domain`, `folder`, `review_due`
 * and `notiert` are preserved in the raw frontmatter block handed to
 * `markdownToYjsState` at import time, but — because Markdown is never
 * canonical — the first materialization run re-derives the `markdown` column
 * purely from the Yjs state and drops whatever is not part of the document
 * body. Turning all 14 frontmatter files into a `COLLECTION` with real
 * properties would fix this; that is a bigger decision than an import script
 * should make on its own (see the final report's follow-up note).
 */
export function renderFrontmatterHeader(frontmatter: Frontmatter): string {
  const unknown = frontmatter.unknown;
  const lines: string[] = [];

  const source = unknown.source_url ?? unknown.quelle;
  if (typeof source === 'string' && source.trim().length > 0) {
    lines.push(`**Quelle:** ${source.trim()}`);
  }

  const savedAt = unknown.saved_at;
  if (typeof savedAt === 'string' && savedAt.trim().length > 0) {
    lines.push(`**Gespeichert:** ${savedAt.trim()}`);
  }

  const portionen = unknown.portionen;
  if (typeof portionen === 'string' && portionen.trim().length > 0) {
    lines.push(`**Portionen:** ${portionen.trim()}`);
  } else if (typeof portionen === 'number') {
    lines.push(`**Portionen:** ${portionen}`);
  }

  const tags = unknown.tags;
  if (Array.isArray(tags)) {
    const rendered = tags
      .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
      .map((tag) => `#${tag.trim().replace(/\s+/g, '-')}`);
    if (rendered.length > 0) lines.push(`**Tags:** ${rendered.join(' ')}`);
  }

  if (lines.length === 0) return '';

  return `> [!info] Details\n${lines.map((line) => `> ${line}`).join('\n>\n')}\n\n`;
}

/**
 * Ranges (as `[start, end)` offsets into `markdown`) that must never be
 * touched by wikilink rewriting: fenced code blocks and inline code spans. A
 * vault about technology guarantees some `[[links]]` sit inside a code
 * example; rewriting them would corrupt the example.
 */
function findProtectedRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  const fencePattern = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fencePattern.exec(markdown)) !== null) {
    ranges.push([fenceMatch.index, fenceMatch.index + fenceMatch[0].length]);
  }

  const inlinePattern = /`[^`\n]+`/g;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlinePattern.exec(markdown)) !== null) {
    ranges.push([inlineMatch.index, inlineMatch.index + inlineMatch[0].length]);
  }

  return ranges;
}

function isWithinRange(index: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

export interface RewriteWikilinksResult {
  text: string;
  /** Every `[[...]]` occurrence found, including ones inside code (left untouched). */
  totalFound: number;
  resolved: number;
  /** Raw (untrimmed alias-less) targets that did not resolve, in source order. */
  unresolvedTargets: string[];
}

/**
 * Resolves a wikilink target against the basename index.
 *
 * Obsidian accepts both a bare title (`[[Note]]`) and a folder-qualified path
 * (`[[Folder/Note]]`) for the same file, and resolves both to it. `byBasename`
 * is keyed on the bare basename only, so a folder-qualified target that does
 * not match directly falls back to its last path segment.
 */
function resolveWikiTarget(
  target: string,
  byBasename: ReadonlyMap<string, string>,
): string | undefined {
  const normalized = normalizeWikiTarget(target);
  const direct = byBasename.get(normalized);
  if (direct !== undefined) return direct;
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) return undefined;
  return byBasename.get(normalized.slice(lastSlash + 1));
}

/**
 * Rewrites `[[Target]]` / `[[Target|Alias]]` occurrences in `markdown`.
 *
 * A target that resolves against `byBasename` becomes the native Exocortex
 * wiki-link syntax `[[Titel]]` / `[[Titel|Label]]` — **not** the
 * `[Label](wiki:Titel)` Markdown-link form. That form was the original plan,
 * but `packages/editor`'s Markdown parser rejects `wiki:` as a link
 * destination protocol for the standard `[text](url)` syntax (its
 * `validateLink` only allows a fixed built-in list), so it does not survive a
 * `parseMarkdown` round trip — confirmed with a throwaway script against the
 * real parser before writing this, per the brief's "verify, don't assume".
 * The double-bracket form is a distinct, dedicated parsing path
 * (`WIKI_LINK_PATTERN` in `packages/editor/src/markdown/parse.ts`) that already
 * produces a `link` mark with an `href` of `wiki:<title>` and round-trips
 * losslessly, including titles that contain spaces.
 *
 * An unresolved target is replaced by its plain text (alias if given, else the
 * target) — never a broken link.
 */
export function rewriteWikilinks(
  markdown: string,
  byBasename: ReadonlyMap<string, string>,
  titleOf: ReadonlyMap<string, string>,
): RewriteWikilinksResult {
  const protectedRanges = findProtectedRanges(markdown);
  const pattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

  let output = '';
  let lastIndex = 0;
  let totalFound = 0;
  let resolved = 0;
  const unresolvedTargets: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    totalFound += 1;
    const start = match.index;
    const end = start + match[0].length;

    // Left untouched: the slice below carries the original text forward
    // unchanged because `lastIndex` is not advanced for a protected match.
    if (isWithinRange(start, protectedRanges)) continue;

    const target = (match[1] ?? '').trim();
    const alias = match[2]?.trim();
    const resolvedPath = resolveWikiTarget(target, byBasename);

    output += markdown.slice(lastIndex, start);
    if (resolvedPath !== undefined) {
      const resolvedTitle = titleOf.get(resolvedPath) ?? target;
      const label = alias ?? resolvedTitle;
      output += label === resolvedTitle ? `[[${resolvedTitle}]]` : `[[${resolvedTitle}|${label}]]`;
      resolved += 1;
    } else {
      output += alias ?? target;
      unresolvedTargets.push(target);
    }
    lastIndex = end;
  }
  output += markdown.slice(lastIndex);

  return { text: output, totalFound, resolved, unresolvedTargets };
}

// ---------------------------------------------------------------------------
// Vault scanning
// ---------------------------------------------------------------------------

const SKIPPED_DIRECTORY_NAMES = new Set(['.obsidian', '.trash', '.debris', '.git']);

export interface ScanResult {
  notes: VaultNote[];
  /** Extension (lowercased, e.g. `.canvas`) -> count. Never `.md`. */
  skipped: Map<string, number>;
}

async function scanVault(vaultRoot: string): Promise<ScanResult> {
  const notes: VaultNote[] = [];
  const skipped = new Map<string, number>();

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      // Dotfiles (`.gitignore`, `.megaignore`, ...) are sync/tooling
      // detritus, not vault content; skip them silently rather than
      // reporting them as "skipped files" alongside real content like
      // `.canvas`/`.csv`.
      if (entry.name.startsWith('.')) continue;

      const extension = path.extname(entry.name).toLowerCase();
      if (extension !== '.md') {
        const key = extension === '' ? '(no extension)' : extension;
        skipped.set(key, (skipped.get(key) ?? 0) + 1);
        continue;
      }

      const relativePath = path.relative(vaultRoot, fullPath).split(path.sep).join('/');
      const folders = relativePath.split('/').slice(0, -1);
      const basename = path.basename(entry.name, '.md');
      const raw = await readFile(fullPath, 'utf8');
      notes.push({ relativePath, folders, basename, raw });
    }
  }

  await walk(vaultRoot);
  notes.sort((a, b) => comparePath(a.relativePath, b.relativePath));
  return { notes, skipped };
}

/** Every distinct folder path (and every ancestor of it), shallowest first. */
function collectFolderPaths(notes: readonly VaultNote[]): string[] {
  const set = new Set<string>();
  for (const note of notes) {
    for (let depth = 1; depth <= note.folders.length; depth += 1) {
      set.add(note.folders.slice(0, depth).join('/'));
    }
  }
  return [...set].sort((a, b) => {
    const depthDiff = a.split('/').length - b.split('/').length;
    return depthDiff !== 0 ? depthDiff : comparePath(a, b);
  });
}

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
// Order keys: siblings must be created in sorted order, and an idempotent
// re-run must continue after whatever already exists rather than colliding.
// ---------------------------------------------------------------------------

async function nextOrderKey(
  prisma: PrismaClient,
  workspaceId: string,
  parentId: string | null,
  cache: Map<string, string | null>,
): Promise<string> {
  const cacheKey = parentId ?? '__root__';
  if (!cache.has(cacheKey)) {
    const last = await prisma.document.findFirst({
      where: { workspaceId, parentId },
      orderBy: [{ orderKey: 'desc' }],
      select: { orderKey: true },
    });
    cache.set(cacheKey, last?.orderKey ?? null);
  }
  const newKey = generateOrderKey(cache.get(cacheKey) ?? null, null);
  cache.set(cacheKey, newKey);
  return newKey;
}

function rememberExistingOrderKey(
  cache: Map<string, string | null>,
  parentId: string | null,
  orderKey: string,
): void {
  const cacheKey = parentId ?? '__root__';
  cache.set(cacheKey, orderKey);
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

  // Pass 3: folder pages, shallowest first.
  const folderPageId = new Map<string, string>();
  let foldersCreated = 0;
  let foldersExisting = 0;

  for (const folderPath of collectFolderPaths(notes)) {
    const segments = folderPath.split('/');
    const title = segments[segments.length - 1] as string;
    const parentPath = segments.slice(0, -1).join('/');
    const parentId = parentPath.length > 0 ? (folderPageId.get(parentPath) ?? null) : null;

    const existing = await prisma.document.findFirst({
      where: { workspaceId, parentId, title, type: 'PAGE' },
      select: { id: true, orderKey: true },
    });

    if (existing !== null) {
      folderPageId.set(folderPath, existing.id);
      rememberExistingOrderKey(orderKeyCache, parentId, existing.orderKey);
      foldersExisting += 1;
      continue;
    }

    foldersCreated += 1;
    if (args.dryRun) {
      folderPageId.set(folderPath, `dry-run:folder:${folderPath}`);
      continue;
    }

    const orderKey = await nextOrderKey(prisma, workspaceId, parentId, orderKeyCache);
    const created = await prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          workspaceId,
          parentId,
          type: 'PAGE',
          title,
          icon: '\u{1F4C1}',
          orderKey,
          createdById: userId,
          updatedById: userId,
        },
        select: { id: true },
      });
      await tx.documentContent.create({
        data: {
          documentId: document.id,
          yjsState: Buffer.from(createEmptyYjsState()),
          schemaVersion: EXOCORTEX_SCHEMA_VERSION,
          materializedAt: new Date(),
        },
      });
      return document;
    });
    folderPageId.set(folderPath, created.id);
  }

  // Pass 4, phase A: note stub pages (id first, content later — wikilinks
  // need every note to already have an id before any of them is resolved).
  const notePageId = new Map<string, string>();
  let notesCreated = 0;

  for (const note of notes) {
    const parentPath = note.folders.join('/');
    const parentId = parentPath.length > 0 ? (folderPageId.get(parentPath) ?? null) : null;
    const title = titleOf.get(note.relativePath) as string;

    const existing = await prisma.document.findFirst({
      where: { workspaceId, parentId, title, type: 'PAGE' },
      select: { id: true, orderKey: true },
    });

    if (existing !== null) {
      notePageId.set(note.relativePath, existing.id);
      rememberExistingOrderKey(orderKeyCache, parentId, existing.orderKey);
      continue;
    }

    notesCreated += 1;
    if (args.dryRun) {
      notePageId.set(note.relativePath, `dry-run:note:${note.relativePath}`);
      continue;
    }

    const orderKey = await nextOrderKey(prisma, workspaceId, parentId, orderKeyCache);
    const created = await prisma.document.create({
      data: {
        workspaceId,
        parentId,
        type: 'PAGE',
        title,
        orderKey,
        createdById: userId,
        updatedById: userId,
      },
      select: { id: true },
    });
    notePageId.set(note.relativePath, created.id);
  }

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

  // Batch the enqueue: 609 jobs at once is a self-inflicted outage on an 8 GB
  // host that is also serving live traffic.
  let materializationEnqueued = 0;
  if (queues !== null) {
    for (let start = 0; start < materializationJobs.length; start += MATERIALIZATION_CHUNK_SIZE) {
      const chunk = materializationJobs.slice(start, start + MATERIALIZATION_CHUNK_SIZE);
      await Promise.all(
        chunk.map((job) =>
          queues.enqueue(QUEUE_NAMES.documentMaterialization, {
            correlationId: createCorrelationId(),
            documentId: job.documentId,
            workspaceId,
            yjsUpdatedAt: Date.now(),
            reason: 'import',
          }),
        ),
      );
      materializationEnqueued += chunk.length;
      if (start + MATERIALIZATION_CHUNK_SIZE < materializationJobs.length) {
        await new Promise((resolve) => setTimeout(resolve, MATERIALIZATION_CHUNK_PAUSE_MS));
      }
    }
  }

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

// ---------------------------------------------------------------------------
// Verification (pass 6) — also runnable standalone with --verify-only
// ---------------------------------------------------------------------------

interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * Recomputes wikilink resolution statistics from the vault text alone (no
 * database access), using the same title/basename index and rewrite logic a
 * real import applies. Used by verification so the expectation is accurate
 * whether it runs right after an import or standalone via `--verify-only`.
 */
function computeExpectedWikilinkStats(notes: readonly VaultNote[]): {
  totalFound: number;
  resolved: number;
  unresolved: number;
} {
  const titleOf = buildTitleIndex(notes);
  const { byBasename } = buildBasenameIndex(notes);

  let totalFound = 0;
  let resolved = 0;
  let unresolved = 0;
  for (const note of notes) {
    const { body } = parseFrontmatter(note.raw);
    const rewritten = rewriteWikilinks(body, byBasename, titleOf);
    totalFound += rewritten.totalFound;
    resolved += rewritten.resolved;
    unresolved += rewritten.unresolvedTargets.length;
  }
  return { totalFound, resolved, unresolved };
}

function pickWord(plainText: string): string | null {
  const words = plainText
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{Letter}\p{Number}]/gu, ''))
    .filter((word) => word.length >= 5);
  return words[0] ?? null;
}

async function runVerification(
  prisma: PrismaClient,
  vaultRoot: string,
  workspaceId: string,
  expectedFailed: number,
): Promise<{ checks: VerificationCheck[]; allPassed: boolean }> {
  const checks: VerificationCheck[] = [];
  const { notes: allNotes } = await scanVault(vaultRoot);
  const titleOf = buildTitleIndex(allNotes);

  // Every scanned note gets a page, even one whose content failed to convert
  // (phase A creates the page before phase B attempts the content, and phase
  // B falls back to an empty placeholder rather than leaving no content row
  // at all) — so the expected count is the full scan, not `scanned - failed`.
  // `expectedFailed` only affects the detail text below.
  const expectedNoteCount = allNotes.length;
  // Folder count is derived the same way import does it.
  const expectedFolderCount = collectFolderPaths(allNotes).length;

  // 1. Note page count. Folder pages carry the '📁' icon marker and notes
  // always have a null icon, so counting pages with a null icon is exact.
  // (Deliberately `icon: null`, not `icon: { not: '📁' }`: Prisma compiles
  // `not` on a nullable column to plain SQL `<>`, which — per three-valued
  // NULL logic — excludes every row where icon is actually null, i.e. every
  // note. Confirmed against the live database before relying on it.)
  const actualNoteCount = await prisma.document.count({
    where: { workspaceId, type: 'PAGE', icon: null },
  });
  checks.push({
    name: 'Note page count',
    passed: actualNoteCount === expectedNoteCount,
    detail: `expected ${expectedNoteCount} (${expectedFailed} of them content-failed placeholders), found ${actualNoteCount}`,
  });

  // 2. Folder page count.
  const folderPagesActual = await prisma.document.count({
    where: { workspaceId, type: 'PAGE', icon: '\u{1F4C1}' },
  });
  checks.push({
    name: 'Folder page count',
    passed: folderPagesActual === expectedFolderCount,
    detail: `expected ${expectedFolderCount} folder pages (icon marker), found ${folderPagesActual}`,
  });

  // 3. Every page has non-empty content. LEFT JOIN deliberately: a page with
  // no `document_content` row at all (which an INNER JOIN would silently
  // miss) is exactly as broken as one with a zero-length yjsState.
  const emptyContentCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count
    FROM "document" d
    LEFT JOIN "document_content" c ON c."documentId" = d.id
    WHERE d."workspaceId" = ${workspaceId} AND (c."documentId" IS NULL OR length(c."yjsState") = 0)
  `;
  const emptyCount = Number(emptyContentCount[0]?.count ?? 0);
  checks.push({
    name: 'Every page has non-empty Yjs content',
    passed: emptyCount === 0,
    detail: `${emptyCount} document(s) with an empty yjsState`,
  });

  // 4. Spot check 5 deterministic notes.
  const spotIndexes = [0, 151, 303, 455, allNotes.length - 1].filter(
    (index, position, all) =>
      index >= 0 && index < allNotes.length && all.indexOf(index) === position,
  );
  for (const index of spotIndexes) {
    const note = allNotes[index] as VaultNote;
    const title = titleOf.get(note.relativePath) as string;
    // `icon: null` (never a folder marker) disambiguates the note page from a
    // same-named folder page: a note that shares its folder's name — e.g.
    // "Watchlist/Watchlist.md" inside the "Watchlist" folder, both titled
    // "Watchlist" — would otherwise let an unordered `findFirst` return the
    // folder page instead of the note.
    const document = await prisma.document.findFirst({
      where: { workspaceId, title, type: 'PAGE', icon: null },
      select: { id: true },
    });
    if (document === null) {
      checks.push({
        name: `Spot check #${index + 1} (${note.relativePath})`,
        passed: false,
        detail: `no document titled "${title}" found`,
      });
      continue;
    }
    const content = await prisma.documentContent.findUnique({
      where: { documentId: document.id },
      select: { yjsState: true, plainText: true },
    });
    const markdown =
      content !== undefined && content !== null ? yjsStateToMarkdown(content.yjsState) : '';
    const firstLine = markdown.split('\n').find((line) => line.trim().length > 0) ?? '';
    const { body } = parseFrontmatter(note.raw);
    // A literal substring match against the raw Markdown body is too fragile:
    // the stored `plainText` is derived from ProseMirror JSON and never
    // contains Markdown syntax (`#`, `**`, `` ` ``, ...), so a sample that
    // happens to include any of it would never match even though the content
    // fully survived. Distinctive-word overlap is robust to that and still
    // verifies real content, not just structure.
    // Extract runs of letters/digits directly (rather than splitting on
    // whitespace and stripping punctuation per token): a hyphenated compound
    // like "KI-Dystopie" must become the two words "KI" and "Dystopie", not
    // the merged, hyphen-free "KIDystopie" — the latter never occurs
    // verbatim in `plainText`, which keeps the original hyphen.
    const distinctiveWords = (
      body.replace(/^#{1,6}\s+.*$/m, '').match(/[\p{Letter}\p{Number}]{6,}/gu) ?? []
    ).slice(0, 10);
    const plainNormalized = (content?.plainText ?? '').toLowerCase();
    const foundWords = distinctiveWords.filter((word) =>
      plainNormalized.includes(word.toLowerCase()),
    );
    const survived =
      distinctiveWords.length === 0 ||
      foundWords.length >= Math.ceil(distinctiveWords.length * 0.6);
    console.log(`Spot check "${title}": ${firstLine}`);
    checks.push({
      name: `Spot check #${index + 1} (${note.relativePath})`,
      passed: survived,
      detail: `title "${title}" round-tripped, ${foundWords.length}/${distinctiveWords.length} distinctive body words found in plainText`,
    });
  }

  // 5. wiki: link mark count vs. resolved. `expectedResolved` is recomputed
  // from a fresh, write-free vault scan (same title/basename index a real
  // import would build), so this check is accurate whether it runs right
  // after an import or standalone via --verify-only.
  const expectedResolved = computeExpectedWikilinkStats(allNotes).resolved;
  // Postgres's ::text cast of a `json` column preserves the exact bytes
  // Prisma's driver sent, which includes a space after every colon
  // (`"href": "wiki:..."`), not the compact form a hand-written pattern would
  // guess — confirmed against the live data before relying on it. A literal
  // (non-regex) needle is used deliberately: a `\s*` pattern here silently
  // returned 0 through Prisma's `$queryRaw` even though the identical SQL
  // returns the correct count via `psql` — some layer between Prisma's query
  // engine and Postgres mangles the backslash. Not worth chasing further
  // since the data has exactly one space, consistently, by construction.
  const wikiLinkOccurrences = await prisma.$queryRaw<Array<{ total: bigint | null }>>`
    SELECT SUM(regexp_count(c."proseMirrorJson"::text, '"href": "wiki:'))::bigint AS total
    FROM "document_content" c
    JOIN "document" d ON d.id = c."documentId"
    WHERE d."workspaceId" = ${workspaceId}
  `;
  const actualWikiLinks = Number(wikiLinkOccurrences[0]?.total ?? 0);
  const tolerance = Math.max(1, Math.ceil(expectedResolved * 0.02));
  checks.push({
    name: 'wiki: link mark count within 2% of resolved',
    passed: Math.abs(actualWikiLinks - expectedResolved) <= tolerance,
    detail: `expected ~${expectedResolved} (±${tolerance}) wiki: hrefs, found ${actualWikiLinks}`,
  });

  // 6. No document has an empty title.
  const emptyTitleCount = await prisma.document.count({ where: { workspaceId, title: '' } });
  checks.push({
    name: 'No empty titles',
    passed: emptyTitleCount === 0,
    detail: `${emptyTitleCount} document(s) with an empty title`,
  });

  // 7. Full-text search.
  if (allNotes.length > 0) {
    const firstNote = allNotes[0] as VaultNote;
    const word = pickWord(firstNote.raw);
    if (word !== null) {
      const adapter = new PostgresSearchAdapter(prisma);
      const results = await adapter.search({
        workspaceId,
        query: word,
        limit: 5,
        includeArchived: false,
      });
      checks.push({
        name: `Full-text search ("${word}")`,
        passed: results.length > 0,
        detail:
          results.length > 0
            ? `${results.length} hit(s)`
            : 'no hits — if this runs immediately after import, the worker may not have drained the queue yet; re-run --verify-only',
      });
    }
  }

  return { checks, allPassed: checks.every((check) => check.passed) };
}

function printVerification(result: { checks: VerificationCheck[]; allPassed: boolean }): void {
  console.log('');
  console.log('Verification:');
  for (const check of result.checks) {
    console.log(`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.name} — ${check.detail}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

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
