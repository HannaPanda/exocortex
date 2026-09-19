import { savedQueryDefinitionSchema } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { type PrismaClient } from './client';
import { describeCollection } from './collection-description';
import { loadDatabaseScope } from './database-derived';
import { runSavedQuery, type SavedQueryRunDeps } from './saved-query';
import { type SearchAdapter } from './search';

/**
 * The sources a conversation has pinned, turned into the text they contribute
 * (issue #75, ADR-043).
 *
 * This lives in `@exocortex/database` rather than in the worker for one
 * reason: the chip row above the composer promises a size, and a promise made
 * from a second implementation is a promise about a different text. The API
 * calls this to answer `GET /api/ai/conversations/:id/sources`, the worker
 * calls it to build the prompt, and both get the same characters -- the same
 * arrangement `describeCollection` already has with the table on screen.
 *
 * Nothing here decides who may read what. The caller has verified that the
 * conversation belongs to it and that every target is in the conversation's
 * workspace; the workspace is part of every statement below, which is what
 * keeps a source from reaching across one.
 */

/** Rows of a pinned saved query that reach the prompt. Past this it is `exo_saved_query_run`'s job. */
const MAX_SAVED_QUERY_ROWS = 15;

/**
 * The floor under one source's share of the budget.
 *
 * Without it, pinning the ninth source would cut the other eight to a few
 * hundred characters each and quietly turn a working context into eight
 * fragments. Below this a source says nothing useful, so it degrades to a
 * pointer instead of pretending.
 */
const MIN_SHARE_CHARS = 600;

export type ConversationSourceKind = 'PAGE' | 'DATABASE_VIEW' | 'SAVED_QUERY';
export type ConversationSourceMode = 'EMBED' | 'REFERENCE';

/** One pinned source, as the row stores it. */
export interface ConversationSourceRef {
  id: string;
  kind: ConversationSourceKind;
  mode: ConversationSourceMode;
  documentId: string | null;
  databaseViewId: string | null;
  savedQueryId: string | null;
}

export interface RenderedConversationSource {
  id: string;
  kind: ConversationSourceKind;
  mode: ConversationSourceMode;
  /** What the chip says, and what the prompt heads the block with. */
  title: string;
  /** Where it sits: the parent page, the view's name, the query's description. */
  subtitle: string | null;
  /** How the model reaches the rest of it. A sentence, not a tool name alone. */
  pointer: string;
  /** The characters this source contributes now. Empty in `REFERENCE` mode. */
  text: string;
  /** What it would contribute without the budget, so the chip can say "gekürzt von". */
  fullChars: number;
  /** The budget cut this source short. Always stated in the prompt as well. */
  truncated: boolean;
  /**
   * The target exists but has nothing to give: a page that was never
   * materialized, a database without columns, a query with no hits. The chip
   * says so rather than showing a zero nobody can explain.
   */
  empty: boolean;
}

export interface ConversationSourceBudget {
  /** `ai.pinnedContextMaxChars`, resolved for the workspace. */
  maxChars: number;
  /** The budget divided by the number of embedded sources, floored at `MIN_SHARE_CHARS`. */
  perSourceChars: number;
  /** What the embedded sources actually take after the cut. */
  usedChars: number;
}

export interface RenderConversationSourcesResult {
  sources: RenderedConversationSource[];
  budget: ConversationSourceBudget;
}

export interface RenderConversationSourcesInput {
  prisma: PrismaClient;
  workspaceId: string;
  sources: readonly ConversationSourceRef[];
  /** `ai.pinnedContextMaxChars`. Zero degrades every source to a pointer. */
  maxChars: number;
  /**
   * The adapters a pinned saved query is answered with. Absent, such a source
   * degrades to a pointer instead of failing the caller -- a size estimate is
   * not worth a broken prompt.
   */
  search?: { hybrid: SearchAdapter; keyword: SearchAdapter };
  logger: Logger;
}

const KIND_LABEL: Record<ConversationSourceKind, string> = {
  PAGE: 'Seite',
  DATABASE_VIEW: 'Datenbankansicht',
  SAVED_QUERY: 'Gespeicherte Suche',
};

/** Keeps an untitled target from becoming an empty chip nobody can identify. */
function displayTitle(title: string, fallback: string): string {
  return title.trim().length === 0 ? fallback : title;
}

/**
 * The share one embedded source may take.
 *
 * Equal shares rather than first-come: spending the budget in order would let
 * one long page eat it and leave the three sources the user pinned afterwards
 * as empty headings, which looks like a bug and is impossible to explain in a
 * chip.
 */
export function perSourceShare(maxChars: number, embeddedCount: number): number {
  if (embeddedCount === 0 || maxChars <= 0) return 0;
  return Math.max(MIN_SHARE_CHARS, Math.floor(maxChars / embeddedCount));
}

function cut(text: string, share: number): { text: string; truncated: boolean } {
  return text.length > share
    ? { text: text.slice(0, share), truncated: true }
    : { text, truncated: false };
}

async function renderPage(input: {
  prisma: PrismaClient;
  workspaceId: string;
  documentId: string;
  embed: boolean;
  share: number;
}): Promise<Omit<RenderedConversationSource, 'id' | 'kind' | 'mode'> | null> {
  const { prisma, workspaceId, documentId, embed, share } = input;
  const document = await prisma.document.findFirst({
    where: { id: documentId, workspaceId },
    select: {
      title: true,
      archivedAt: true,
      parent: { select: { title: true } },
      content: { select: { markdown: true, plainText: true } },
    },
  });
  if (document === null) return null;

  const title = displayTitle(document.title, 'Unbenannte Seite');
  const parentTitle = document.parent?.title ?? null;
  const subtitleParts = [
    parentTitle === null ? null : `in ${displayTitle(parentTitle, 'Unbenannte Seite')}`,
    document.archivedAt === null ? null : 'archiviert',
  ].filter((part): part is string => part !== null);

  const body = document.content?.markdown ?? document.content?.plainText ?? '';
  const trimmed = body.trim();
  const rendered = embed ? cut(trimmed, share) : { text: '', truncated: false };

  return {
    title,
    subtitle: subtitleParts.length === 0 ? null : subtitleParts.join(', '),
    pointer: `Den vollständigen Text holst du mit \`exo_page_read\` und documentId ${documentId}.`,
    text: rendered.text,
    fullChars: trimmed.length,
    truncated: rendered.truncated,
    empty: trimmed.length === 0,
  };
}

async function renderDatabaseView(input: {
  prisma: PrismaClient;
  workspaceId: string;
  documentId: string;
  databaseViewId: string | null;
  embed: boolean;
  share: number;
  logger: Logger;
}): Promise<Omit<RenderedConversationSource, 'id' | 'kind' | 'mode'> | null> {
  const { prisma, workspaceId, documentId, databaseViewId, embed, share, logger } = input;
  const document = await prisma.document.findFirst({
    where: { id: documentId, workspaceId, type: 'COLLECTION' },
    select: { title: true },
  });
  if (document === null) return null;

  const view =
    databaseViewId === null
      ? null
      : await prisma.databaseView.findFirst({
          where: { id: databaseViewId, documentId },
          select: { name: true },
        });

  // Best-effort, exactly as the open page's own description is: a malformed
  // filter blob or a failing row query costs this block, never the run.
  const description = await describeCollection({
    prisma,
    workspaceId,
    documentId,
    viewId: databaseViewId,
    logger,
  }).catch((error: unknown) => {
    logger.info('Skipping the description of a pinned database view', {
      documentId,
      workspaceId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  });

  const full = (description ?? '').trim();
  const rendered = embed ? cut(full, share) : { text: '', truncated: false };

  return {
    title: displayTitle(document.title, 'Unbenannte Datenbank'),
    subtitle: view === null ? null : `Ansicht ${view.name}`,
    pointer: `Weitere Zeilen holst du mit \`exo_database_query\` und documentId ${documentId}.`,
    text: rendered.text,
    fullChars: full.length,
    truncated: rendered.truncated,
    empty: full.length === 0,
  };
}

async function renderSavedQuery(input: {
  prisma: PrismaClient;
  workspaceId: string;
  savedQueryId: string;
  embed: boolean;
  share: number;
  search: { hybrid: SearchAdapter; keyword: SearchAdapter } | undefined;
  logger: Logger;
}): Promise<Omit<RenderedConversationSource, 'id' | 'kind' | 'mode'> | null> {
  const { prisma, workspaceId, savedQueryId, embed, share, search, logger } = input;
  const row = await prisma.savedQuery.findFirst({
    where: { id: savedQueryId, workspaceId },
    select: { name: true, description: true, definition: true },
  });
  if (row === null) return null;

  const pointer = `Die vollständige Trefferliste holst du mit \`exo_saved_query_run\` und savedQueryId ${savedQueryId}.`;
  const head = {
    title: displayTitle(row.name, 'Unbenannte Suche'),
    subtitle: row.description,
    pointer,
  };

  const parsed = savedQueryDefinitionSchema.safeParse(row.definition);
  if (!parsed.success || !embed || search === undefined) {
    if (!parsed.success) {
      logger.info('Pinned saved query has a definition that no longer parses', {
        savedQueryId,
        workspaceId,
      });
    }
    return { ...head, text: '', fullChars: 0, truncated: false, empty: !parsed.success };
  }

  const definition = parsed.data;
  const deps: SavedQueryRunDeps = {
    prisma,
    hybrid: search.hybrid,
    keyword: search.keyword,
    scope:
      definition.collectionId === null
        ? undefined
        : ((await loadDatabaseScope(prisma, definition.collectionId).catch(() => undefined)) ??
          undefined),
  };

  const result = await runSavedQuery(deps, {
    workspaceId,
    definition,
    limit: MAX_SAVED_QUERY_ROWS,
  }).catch((error: unknown) => {
    logger.info('Skipping the hits of a pinned saved query', {
      savedQueryId,
      workspaceId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  });

  if (result === null || result.rows.length === 0) {
    return { ...head, text: '', fullChars: 0, truncated: false, empty: true };
  }

  const lines = result.rows.map((hit) => {
    const snippet = hit.snippet.replace(/\s+/g, ' ').trim();
    const suffix = snippet.length === 0 ? '' : ` — ${snippet}`;
    return `- ${displayTitle(hit.title, 'Unbenannte Seite')} (documentId: ${hit.documentId})${suffix}`;
  });
  if (result.truncated) {
    lines.push(`- … weitere Treffer, hier abgeschnitten bei ${MAX_SAVED_QUERY_ROWS}.`);
  }

  const full = lines.join('\n');
  const rendered = cut(full, share);
  return {
    ...head,
    text: rendered.text,
    fullChars: full.length,
    truncated: rendered.truncated || result.truncated,
    empty: false,
  };
}

/**
 * Resolves every pinned source to the text it contributes, inside one budget.
 *
 * A source whose target is gone is dropped rather than rendered as a dangling
 * id: the row is deleted with the target (`onDelete: Cascade`), so seeing one
 * here means the target moved out of this workspace, and a title from
 * somewhere else must never reach a prompt.
 */
export async function renderConversationSources(
  input: RenderConversationSourcesInput,
): Promise<RenderConversationSourcesResult> {
  const { prisma, workspaceId, sources, maxChars, search, logger } = input;

  const embeddedCount = sources.filter((source) => source.mode === 'EMBED').length;
  const share = perSourceShare(maxChars, embeddedCount);

  const rendered: RenderedConversationSource[] = [];
  for (const source of sources) {
    const embed = source.mode === 'EMBED' && share > 0;
    const head = { id: source.id, kind: source.kind, mode: source.mode };

    let body: Omit<RenderedConversationSource, 'id' | 'kind' | 'mode'> | null = null;
    switch (source.kind) {
      case 'PAGE':
        body =
          source.documentId === null
            ? null
            : await renderPage({
                prisma,
                workspaceId,
                documentId: source.documentId,
                embed,
                share,
              });
        break;
      case 'DATABASE_VIEW':
        body =
          source.documentId === null
            ? null
            : await renderDatabaseView({
                prisma,
                workspaceId,
                documentId: source.documentId,
                databaseViewId: source.databaseViewId,
                embed,
                share,
                logger,
              });
        break;
      case 'SAVED_QUERY':
        body =
          source.savedQueryId === null
            ? null
            : await renderSavedQuery({
                prisma,
                workspaceId,
                savedQueryId: source.savedQueryId,
                embed,
                share,
                search,
                logger,
              });
        break;
    }

    if (body === null) {
      logger.info('Pinned source points at a target outside this workspace; dropping it', {
        sourceId: source.id,
        kind: source.kind,
        workspaceId,
      });
      continue;
    }
    rendered.push({ ...head, ...body });
  }

  return {
    sources: rendered,
    budget: {
      maxChars,
      perSourceChars: share,
      usedChars: rendered.reduce((total, source) => total + source.text.length, 0),
    },
  };
}

/** The German word for a source kind, for a prompt heading and for an error message. */
export function conversationSourceKindLabel(kind: ConversationSourceKind): string {
  return KIND_LABEL[kind];
}
