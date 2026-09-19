import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canReadDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type ParentSuggestion,
  type SuggestParentRequest,
  type SuggestParentResponse,
} from '@exocortex/contracts';
import { collectAncestors, type PrismaClient, type SearchAdapter } from '@exocortex/database';

import { PRISMA } from '../platform/platform.module';
import { SEARCH_ADAPTER } from '../search/search.service';

/** How many neighbouring pages are consulted before their parents are ranked. */
const NEIGHBOUR_LIMIT = 24;

/** Suggestions returned when the caller names no limit. */
const DEFAULT_LIMIT = 3;

/** How much of an existing page's text is used to describe it. */
const MAX_QUERY_CHARS = 1_000;

/**
 * A neighbour that is itself a section counts for its own candidacy too, at
 * half weight. The nearest page to "local music models" may well be the
 * "Creative & Media" page rather than one of the pages under it, and without
 * this the right answer would only be reachable through its parent.
 */
const CONTAINER_WEIGHT = 0.5;

interface DocumentRow {
  id: string;
  parentId: string | null;
  title: string;
  type: 'PAGE' | 'COLLECTION' | 'PROJECT';
}

/**
 * "Where does this page belong?" as a question the workspace answers about
 * itself.
 *
 * Every client that files a page has the same blind spot: it knows the page and
 * not the shelf. An agent that creates "Lokale Musik-KI-Modelle" under
 * "AI & Tools" is not being careless, it simply never saw that "Creative &
 * Media" sits one level below with fifteen pages of exactly that kind in it.
 *
 * So the suggestion is built from evidence rather than from taxonomy: the pages
 * closest to this subject are looked up through the ordinary search adapter
 * (semantic when it is switched on, full-text otherwise, ADR-020), and their
 * parents are ranked by how much of that closeness landed there. Nothing is
 * written, nothing is moved, and the matches that produced each candidate
 * travel with it so a reader can disagree with the argument rather than only
 * with the conclusion.
 */
@Injectable()
export class DocumentPlacementService {
  constructor(
    @Inject(SEARCH_ADAPTER) private readonly adapter: SearchAdapter,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
  ) {}

  async suggestParent(
    workspaceId: string,
    userId: string,
    request: SuggestParentRequest,
  ): Promise<SuggestParentResponse> {
    const scoped = await this.access.requireScopedRole(workspaceId, userId);

    const query = await this.buildQuery(workspaceId, userId, request);
    if (query.length === 0) {
      return { query, adapter: this.adapter.id, suggestions: [] };
    }

    const [found, all] = await Promise.all([
      this.adapter.search({
        workspaceId,
        query,
        limit: NEIGHBOUR_LIMIT,
        includeArchived: false,
      }),
      this.prisma.document.findMany({
        where: { workspaceId, archivedAt: null },
        select: { id: true, parentId: true, title: true, type: true },
      }),
    ]);
    // Suggesting a home for a page is a reading of the whole tree, so a
    // confined credential is only ever offered somewhere inside its own branch
    // (issue #83) -- suggesting a parent it may not write to would be advice
    // that cannot be taken.
    const hits =
      scoped.documentIds === null
        ? found
        : found.filter((hit) => (scoped.documentIds as Set<string>).has(hit.documentId));
    const rows =
      scoped.documentIds === null
        ? all
        : all.filter((row) => (scoped.documentIds as Set<string>).has(row.id));

    const byId = new Map(rows.map((row) => [row.id, row]));
    const childCounts = new Map<string | null, number>();
    for (const row of rows) {
      childCounts.set(row.parentId, (childCounts.get(row.parentId) ?? 0) + 1);
    }

    const excluded = this.excludedIds(rows, request.documentId);
    const candidates = this.rank(hits, byId, excluded);

    const limit = request.limit ?? DEFAULT_LIMIT;
    const suggestions = [...candidates.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((candidate) => this.describe(candidate, rows, childCounts));

    return { query, adapter: this.adapter.id, suggestions };
  }

  /**
   * What the neighbours are looked up with: the caller's own words, plus the
   * page's title and the opening of its text when it already exists.
   */
  private async buildQuery(
    workspaceId: string,
    userId: string,
    request: SuggestParentRequest,
  ): Promise<string> {
    const parts: string[] = [];
    if (request.documentId !== undefined) {
      const context = await this.access.requireDocumentContext(request.documentId, userId);
      assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));
      const document = await this.prisma.document.findFirst({
        where: { id: request.documentId, workspaceId },
        select: { title: true, content: { select: { plainText: true } } },
      });
      if (document !== null) {
        parts.push(document.title);
        const text = document.content?.plainText ?? '';
        if (text.length > 0) parts.push(text.slice(0, MAX_QUERY_CHARS));
      }
    }
    if (request.title !== undefined) parts.push(request.title);
    if (request.summary !== undefined) parts.push(request.summary.slice(0, MAX_QUERY_CHARS));
    return parts.join('\n').trim();
  }

  /**
   * The page itself and everything under it.
   *
   * A page cannot be filed into its own subtree, and offering it as a
   * destination would produce a suggestion the move endpoint then refuses.
   */
  private excludedIds(rows: readonly DocumentRow[], documentId?: string): Set<string> {
    const excluded = new Set<string>();
    if (documentId === undefined) return excluded;
    excluded.add(documentId);
    // Repeated passes rather than a recursive walk: the rows arrive in no
    // particular order, and a workspace is small enough that a handful of
    // sweeps costs nothing.
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows) {
        if (row.parentId !== null && excluded.has(row.parentId) && !excluded.has(row.id)) {
          excluded.add(row.id);
          grew = true;
        }
      }
    }
    return excluded;
  }

  /**
   * Turns ranked neighbours into scored candidate parents.
   *
   * The weight falls off with the position rather than with the reported rank:
   * the hybrid adapter fuses two lists and its numbers are not on one scale, so
   * only the order they produce can be trusted.
   */
  private rank(
    hits: readonly { documentId: string; rank: number }[],
    byId: Map<string, DocumentRow>,
    excluded: Set<string>,
  ): Map<string | null, Candidate> {
    const candidates = new Map<string | null, Candidate>();
    const add = (
      parentId: string | null,
      weight: number,
      hit: { documentId: string; rank: number },
      row: DocumentRow,
    ): void => {
      const existing = candidates.get(parentId) ?? { parentId, score: 0, matches: [] };
      existing.score += weight;
      existing.matches.push({
        documentId: hit.documentId,
        title: row.title,
        similarity: hit.rank,
      });
      candidates.set(parentId, existing);
    };

    hits.forEach((hit, position) => {
      const row = byId.get(hit.documentId);
      if (row === undefined || excluded.has(row.id)) return;
      const weight = 1 / (1 + position);

      // A database row is not a filing place: its parent is a COLLECTION, and
      // a page filed under one would become a row with no properties (ADR-011).
      const parent = row.parentId === null ? null : byId.get(row.parentId);
      if (parent === undefined) return;
      if (parent === null || parent.type === 'PAGE') {
        add(row.parentId, weight, hit, row);
      }

      // The neighbour itself, when it is a page that already holds pages.
      if (row.type === 'PAGE' && !excluded.has(row.id)) {
        const holdsPages = [...byId.values()].some((other) => other.parentId === row.id);
        if (holdsPages) add(row.id, weight * CONTAINER_WEIGHT, hit, row);
      }
    });

    return candidates;
  }

  private describe(
    candidate: Candidate,
    rows: readonly DocumentRow[],
    childCounts: Map<string | null, number>,
  ): ParentSuggestion {
    const row = candidate.parentId === null ? null : rows.find((r) => r.id === candidate.parentId);
    return {
      parentId: candidate.parentId,
      title: row?.title ?? 'Oberste Ebene',
      path:
        candidate.parentId === null
          ? []
          : collectAncestors(rows, candidate.parentId).map((entry) => ({
              id: entry.id,
              title: entry.title,
            })),
      score: Number(candidate.score.toFixed(4)),
      childCount: childCounts.get(candidate.parentId) ?? 0,
      matches: candidate.matches.slice(0, 5),
    };
  }
}

interface Candidate {
  parentId: string | null;
  score: number;
  matches: ParentSuggestion['matches'];
}
