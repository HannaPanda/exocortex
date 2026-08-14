import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { type Frontmatter, parseMarkdown } from '@exocortex/editor';

// ---------------------------------------------------------------------------
// Reading a vault: the pure text helpers (unit tested in
// import-obsidian.test.ts) and the directory walk that feeds them.
//
// Everything here is about the files on disk and knows nothing about
// Exocortex; the importer beside it is the part that writes.
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

export async function scanVault(vaultRoot: string): Promise<ScanResult> {
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
export function collectFolderPaths(notes: readonly VaultNote[]): string[] {
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
