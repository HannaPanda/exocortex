import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceAccessService } from '@exocortex/auth';
import {
  type ContextCompileRequest,
  type ContextCompileResponse,
  type DocumentPathEntry,
} from '@exocortex/contracts';
import {
  defaultPerSourceMaxChars,
  packContext,
  type PackSource,
  type PassageScope,
  type PassageSearchPort,
  type PrismaClient,
} from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';
import { PASSAGE_SEARCH, SearchService } from '../search/search.service';

/**
 * Pages the keyword half cuts into passages. The same order of magnitude a
 * search result list has; the packer rarely gets past the first dozen.
 */
const KEYWORD_PAGE_LIMIT = 30;

/**
 * Passage rows the semantic half reads. Three per page for the pages an
 * answer can name at most, which is the same oversampling the page search
 * uses before it folds (ADR-034).
 */
const SEMANTIC_PASSAGE_LIMIT = 90;

interface ReadableWorkspace {
  id: string;
  name: string;
  isMemory: boolean;
}

/**
 * The context compiler (issue #110, ADR-061): a question and a budget in,
 * verbatim passages with their provenance out.
 *
 * Retrieval and selection only. No model writes a word of the answer, so there
 * is nothing in it that is not on a page the caller can open, and a
 * deployment without a generative model still has it.
 *
 * Authority is exactly the search's: membership per workspace, and a confined
 * credential's page set applied inside the query (see `PassageScope`). A
 * workspace the caller cannot read is refused with the error a search would
 * give when it was named, and simply not looked in when it was not.
 */
@Injectable()
export class ContextService {
  constructor(
    @Inject(PASSAGE_SEARCH) private readonly passages: PassageSearchPort,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly search: SearchService,
  ) {}

  async compile(userId: string, request: ContextCompileRequest): Promise<ContextCompileResponse> {
    const startedAt = Date.now();
    const workspaces = await this.workspacesFor(userId, request.workspaceIds);

    const scopes: PassageScope[] = [];
    const visibleByWorkspace = new Map<string, Set<string> | null>();
    for (const workspace of workspaces) {
      const scoped = await this.access.requireScopedRole(workspace.id, userId);
      visibleByWorkspace.set(workspace.id, scoped.documentIds);
      // A confined credential that reaches nothing here is not asked about it
      // at all: an empty scope would still be a query, and a cheap one is
      // still a timing difference.
      if (scoped.documentIds !== null && scoped.documentIds.size === 0) continue;
      scopes.push({
        workspaceId: workspace.id,
        documentIds: scoped.documentIds === null ? null : [...scoped.documentIds],
      });
    }

    const { candidates, stages } = await this.passages.searchPassages({
      scopes,
      query: request.q,
      pageLimit: KEYWORD_PAGE_LIMIT,
      passageLimit: SEMANTIC_PASSAGE_LIMIT,
    });

    const sources = await this.sourcesFor(candidates, workspaces, visibleByWorkspace);
    const packed = packContext(candidates, sources, {
      maxChars: request.maxChars,
      maxSources: request.maxSources,
      perSourceMaxChars: Math.min(
        request.perSourceMaxChars ?? defaultPerSourceMaxChars(request.maxChars, request.maxSources),
        request.maxChars,
      ),
    });
    const tookMs = Date.now() - startedAt;

    // Counts only. The question and the passages are what a person asked and
    // what their pages say, and neither belongs in a log.
    this.logger.info('Context compiled', {
      workspaces: scopes.length,
      stages: stages.join(','),
      candidates: candidates.length,
      sources: packed.sources.length,
      passages: packed.selected,
      usedChars: packed.text.length,
      maxChars: request.maxChars,
      truncated: packed.truncated,
      tookMs,
    });

    return {
      query: request.q,
      sources: packed.sources,
      text: packed.text,
      usedChars: packed.text.length,
      truncated: packed.truncated,
      candidates: candidates.length,
      selected: packed.selected,
      stages,
      tookMs,
    };
  }

  /**
   * The workspaces to look in.
   *
   * Named ones are checked by `requireScopedRole` in the caller, which throws
   * the same refusal for a workspace that does not exist as for one the
   * caller is not a member of. Unnamed means every membership except the
   * memory area, whose session notes are `memory/recall`'s to answer from.
   */
  private async workspacesFor(
    userId: string,
    named: readonly string[] | undefined,
  ): Promise<ReadableWorkspace[]> {
    if (named !== undefined) {
      const unique = [...new Set(named)];
      const rows = await this.prisma.workspace.findMany({
        where: { id: { in: unique } },
        select: { id: true, name: true, isMemory: true },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      // An unknown id keeps its place so the access check refuses it, rather
      // than being dropped here and answering as if it were empty.
      return unique.map((id) => byId.get(id) ?? { id, name: '', isMemory: false });
    }
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId, workspace: { archivedAt: null, isMemory: false } },
      select: { workspace: { select: { id: true, name: true, isMemory: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((membership) => membership.workspace);
  }

  /** Header data for every page a candidate came from, paths confined like a search's. */
  private async sourcesFor(
    candidates: readonly {
      documentId: string;
      workspaceId: string;
      title: string;
      updatedAt: string;
    }[],
    workspaces: readonly ReadableWorkspace[],
    visibleByWorkspace: ReadonlyMap<string, Set<string> | null>,
  ): Promise<Map<string, PackSource>> {
    const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
    const byWorkspace = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      const ids = byWorkspace.get(candidate.workspaceId) ?? new Set<string>();
      ids.add(candidate.documentId);
      byWorkspace.set(candidate.workspaceId, ids);
    }

    const paths = new Map<string, DocumentPathEntry[]>();
    for (const [workspaceId, ids] of byWorkspace) {
      // Every candidate comes from a workspace that was checked above; one
      // that was not would be a bug, and it names no ancestors rather than all.
      const visible = visibleByWorkspace.has(workspaceId)
        ? (visibleByWorkspace.get(workspaceId) ?? null)
        : new Set<string>();
      const resolved = await this.search.resolvePaths(workspaceId, [...ids], visible);
      for (const [documentId, path] of resolved) paths.set(documentId, path);
    }

    const sources = new Map<string, PackSource>();
    for (const candidate of candidates) {
      if (sources.has(candidate.documentId)) continue;
      sources.set(candidate.documentId, {
        documentId: candidate.documentId,
        workspaceId: candidate.workspaceId,
        workspaceName: names.get(candidate.workspaceId) ?? '',
        title: candidate.title,
        path: paths.get(candidate.documentId) ?? [],
        updatedAt: candidate.updatedAt,
      });
    }
    return sources;
  }
}
