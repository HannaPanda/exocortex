import { createHash } from 'node:crypto';

import { type PrismaClient } from './client';
import { buildTree, collectAncestors } from './tree';

/**
 * What goes into a render, read once and read the same way twice (issue #44).
 *
 * This lives here, next to Prisma and the tree helpers, because two processes
 * need the identical answer: the API computes the input hash when it accepts a
 * render request (that is what makes the cache and the staleness flag mean
 * something), and the worker assembles the text when it builds. Two
 * implementations would agree on the day they were written and differ by a
 * newline afterwards, and the difference would only ever show up as a PDF that
 * refuses to be reused.
 */

/** The most source text one render may carry. A book is not a page render. */
export const RENDER_MAX_SOURCE_CHARS = 2_000_000;

export type RenderSourceKind = 'DOCUMENT' | 'SUBTREE';

export interface RenderSourcePage {
  id: string;
  title: string;
  /** Levels below the root page. Zero for the root itself. */
  depth: number;
}

export interface AssembledRenderSource {
  /** Title of the root page. */
  title: string;
  /** Path from the workspace root to the page, joined for display. */
  path: string;
  /** The Markdown handed to Pandoc. */
  text: string;
  /** Every page that contributed, root first, in tree order. */
  pages: RenderSourcePage[];
  /** True when at least one page has never been materialized. */
  incomplete: boolean;
}

/**
 * Moves every ATX heading in a Markdown document `by` levels deeper.
 *
 * Needed because a sub-page's own `# Überschrift` has to become a section
 * inside the chapter its page title opens, or a subtree render produces a PDF
 * with a dozen competing top-level headings.
 *
 * Fenced code blocks are skipped: `# comment` on the first line of a shell
 * snippet is not a heading, and shifting it would corrupt the code. Headings
 * deeper than six levels stay at six, which is what Markdown itself does.
 */
export function shiftMarkdownHeadings(markdown: string, by: number): string {
  if (by <= 0) return markdown;

  let fence: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fenceMatch !== null) {
        const marker = fenceMatch[1] ?? '';
        if (fence === null) {
          fence = marker[0] ?? null;
        } else if (marker.startsWith(fence)) {
          fence = null;
        }
        return line;
      }
      if (fence !== null) return line;

      const heading = /^(#{1,6})(\s)/.exec(line);
      if (heading === null) return line;
      const level = Math.min((heading[1] ?? '').length + by, 6);
      return `${'#'.repeat(level)}${line.slice((heading[1] ?? '').length)}`;
    })
    .join('\n');
}

/** One page's contribution: a heading with its title, then its own Markdown. */
function sectionFor(page: { title: string; markdown: string }, depth: number): string {
  const body = shiftMarkdownHeadings(page.markdown.trim(), depth);
  const heading = `${'#'.repeat(Math.min(depth + 1, 6))} ${page.title}`;
  return body.length === 0 ? heading : `${heading}\n\n${body}`;
}

interface OrderedPage {
  page: LoadedPage;
  depth: number;
}

interface LoadedPage {
  id: string;
  title: string;
  parentId: string | null;
  orderKey: string;
  markdown: string | null;
}

/**
 * Reads the Markdown a render is built from.
 *
 * The root page contributes its body without a title heading: Pandoc puts the
 * document title on the title page, and repeating it as the first line of the
 * body is the single most common thing wrong with a generated PDF. Every
 * descendant contributes a heading and then its body, one level per step down
 * the tree, which is how a page with sub-pages becomes a document with
 * chapters.
 */
export async function loadRenderSource(
  prisma: PrismaClient,
  input: { documentId: string; source: RenderSourceKind },
): Promise<AssembledRenderSource | null> {
  const root = await prisma.document.findUnique({
    where: { id: input.documentId },
    select: { id: true, title: true, parentId: true, workspaceId: true },
  });
  if (root === null) return null;

  const siblings = await prisma.document.findMany({
    where: { workspaceId: root.workspaceId },
    select: { id: true, title: true, parentId: true },
  });
  const path = [...collectAncestors(siblings, root.id).map((row) => row.title), root.title].join(
    ' / ',
  );

  const ordered: OrderedPage[] =
    input.source === 'DOCUMENT'
      ? await loadSinglePage(prisma, root.id)
      : orderSubtree(await loadSubtreePages(prisma, root.workspaceId), root.id);

  const parts: string[] = [];
  const pages: RenderSourcePage[] = [];
  let incomplete = false;

  for (const [index, entry] of ordered.entries()) {
    const markdown = entry.page.markdown;
    if (markdown === null) {
      incomplete = true;
      continue;
    }
    pages.push({ id: entry.page.id, title: entry.page.title, depth: entry.depth });
    parts.push(
      index === 0 && entry.depth === 0
        ? markdown.trim()
        : sectionFor({ title: entry.page.title, markdown }, entry.depth),
    );
  }

  return {
    title: root.title,
    path,
    text: parts.join('\n\n').slice(0, RENDER_MAX_SOURCE_CHARS),
    pages,
    incomplete,
  };
}

async function loadSinglePage(prisma: PrismaClient, documentId: string): Promise<OrderedPage[]> {
  const row = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      title: true,
      parentId: true,
      orderKey: true,
      content: { select: { markdown: true } },
    },
  });
  if (row === null) return [];
  return [{ page: { ...row, markdown: row.content?.markdown ?? null }, depth: 0 }];
}

/**
 * Every non-archived page of the workspace, with its Markdown.
 *
 * The whole workspace and not a recursive descent: the tree helpers here work
 * on a flat list, one query beats a walk of unknown depth, and the archived
 * ones are left out because a chapter nobody can see in the sidebar has no
 * business appearing in a PDF.
 */
async function loadSubtreePages(prisma: PrismaClient, workspaceId: string): Promise<LoadedPage[]> {
  const rows = await prisma.document.findMany({
    where: { workspaceId, archivedAt: null },
    select: {
      id: true,
      title: true,
      parentId: true,
      orderKey: true,
      content: { select: { markdown: true } },
    },
  });
  return rows.map((row) => ({ ...row, markdown: row.content?.markdown ?? null }));
}

/** Depth-first walk from the root, siblings in `orderKey` order. */
function orderSubtree(rows: readonly LoadedPage[], rootId: string): OrderedPage[] {
  const tree = buildTree(rows.map((row) => ({ ...row, parentId: row.parentId })));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result: OrderedPage[] = [];

  const findRoot = (
    nodes: ReturnType<typeof buildTree<LoadedPage>>,
  ): (typeof nodes)[number] | null => {
    for (const node of nodes) {
      if (node.node.id === rootId) return node;
      const found = findRoot(node.children);
      if (found !== null) return found;
    }
    return null;
  };

  const walk = (node: ReturnType<typeof buildTree<LoadedPage>>[number], depth: number): void => {
    const page = byId.get(node.node.id);
    if (page !== undefined) result.push({ page, depth });
    for (const child of node.children) walk(child, depth + 1);
  };

  const start = findRoot(tree);
  if (start !== null) walk(start, 0);
  return result;
}

/**
 * The fingerprint two builds are compared by.
 *
 * Everything that changes the bytes of the output goes in, and nothing else.
 * The container image deliberately does not: it is not read at request time,
 * and a hash that quietly changed under every deployment would make the cache
 * useless. Changing the image is what `force` on a render request is for.
 */
export function renderInputHash(input: {
  renderer: string;
  source: string;
  text: string;
  template: string | null;
  variables: Readonly<Record<string, string>>;
}): string {
  const variables = Object.keys(input.variables)
    .sort()
    .map((key) => `${key}=${input.variables[key] ?? ''}`)
    .join(' ');
  return createHash('sha256')
    .update(
      [input.renderer, input.source, input.template ?? '<builtin>', variables, input.text].join(''),
    )
    .digest('hex');
}
