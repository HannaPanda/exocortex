import { Inject, Injectable } from '@nestjs/common';

import { type ApiEnv } from '@exocortex/config';
import {
  type MemoryCaptureRequest,
  type MemoryCaptureResponse,
  type MemoryHit,
  type MemoryRecallEntity,
  type MemoryRecallFact,
  type MemoryRecallRequest,
  type MemoryRecallResponse,
  type MemoryRememberRequest,
  type MemoryRememberResponse,
  QUEUE_NAMES,
  type SearchResult,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { matchEntityAliases } from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { DocumentContentService } from '../documents/document-content.service';
import { DocumentsService } from '../documents/documents.service';
import { EntityProfileService } from '../entities/entity-profile.service';
import { EntityRegistryService } from '../entities/entity-registry.service';
import { PRISMA, QUEUES } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';
import { SearchService } from '../search/search.service';

import { renderMessages, unreadMessagesForRecall } from './agent-messages.service';
import { normaliseProject, projectLabel } from './memory-project';
import { memoryWorkspaceFor } from './memory-workspace';

/** How many hits one workspace may contribute before merging and re-ranking. */
const PER_WORKSPACE_LIMIT = 10;
/** Longest snippet a single hit may add to the recall text. */
const MAX_SNIPPET_CHARS = 400;
/** How many recent notes a recall without a query falls back to. */
const RECENT_FALLBACK_LIMIT = 20;
/**
 * Share of a recall's character budget the distilled facts may take.
 *
 * A third, not more: facts are the better answer but the thinner one, and a
 * recall that is nothing but standing statements has lost the detail an agent
 * actually works from.
 */
const FACT_BUDGET_SHARE = 1 / 3;
/**
 * Share of the budget an entity profile may take (issue #47).
 *
 * A quarter, and only when the question actually named an entity. A profile is
 * the best answer a recall has when it applies, and applies to a minority of
 * questions; giving it a standing share would shrink every other recall for a
 * block that is usually empty.
 */
const ENTITY_BUDGET_SHARE = 1 / 4;
/** Entities one recall names. Two, because a question rarely means three. */
const MAX_RECALL_ENTITIES = 2;
/**
 * Share of the budget unread mail may take (issue #51).
 *
 * A quarter, and usually nothing: an empty mailbox costs a recall nothing at
 * all. The share matters on the day somebody has written three messages, and
 * the point of capping it is that a full mailbox must not push out the notes
 * the session was actually started to work from.
 */
const MESSAGE_BUDGET_SHARE = 1 / 4;

/**
 * A hit from the agents' own area is worth more than an equally ranked hit from
 * the curated knowledge base, because the question a recall answers is "what
 * did we already do here". Applied to the score, not by sorting in two blocks:
 * one strong knowledge hit should still beat five weak memories.
 */
const MEMORY_BOOST = 1.5;
/** Extra weight for a memory that belongs to the project the caller named. */
const PROJECT_BOOST = 2;

/**
 * eXocortex as a memory for external agents (issue #34).
 *
 * Three verbs above the ordinary domain: `recall` reads across every workspace
 * the caller may read, `remember` writes one distilled note into the configured
 * memory workspace, and `capture` hands a finished session to the worker so a
 * model can distil it. Nothing here reaches past the services a human's request
 * goes through, so an agent can do exactly what its account can do.
 */
@Injectable()
export class MemoryService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly settings: SettingsService,
    private readonly search: SearchService,
    private readonly documents: DocumentsService,
    private readonly content: DocumentContentService,
    private readonly entityRegistry: EntityRegistryService,
    private readonly entityProfiles: EntityProfileService,
  ) {}

  async recall(userId: string, request: MemoryRecallRequest): Promise<MemoryRecallResponse> {
    const startedAt = Date.now();
    // The caller's own memory area decides the regulators below: how many hits
    // a recall answers with and how long it may be are workspace-scoped keys
    // now (ADR-023), and the workspace they belong to is this one.
    const memoryWorkspaceId = await memoryWorkspaceFor(this.prisma, userId);
    const settings =
      memoryWorkspaceId === null
        ? await this.settings.get()
        : await this.settings.getForWorkspace(memoryWorkspaceId);
    const limit = Math.min(request.limit, settings['memory.recallMaxResults']);
    const maxChars = Math.min(request.maxChars, settings['memory.recallMaxChars']);
    const project = request.project === undefined ? null : normaliseProject(request.project);

    const workspaces = await this.readableWorkspaces(userId);
    const searchable = workspaces.filter(
      (workspace) => request.includeKnowledge || workspace.id === memoryWorkspaceId,
    );

    const hits =
      request.q === undefined
        ? await this.recentNotes({ userId, memoryWorkspaceId, project, workspaces })
        : await this.searchAcross({
            userId,
            query: request.q,
            workspaces: searchable,
            memoryWorkspaceId,
            project,
          });

    const facts =
      project === null || memoryWorkspaceId === null
        ? []
        : await this.currentFacts({
            workspaceId: memoryWorkspaceId,
            projectKey: project,
            readable: workspaces,
            limit: settings['memory.recallFactLimit'],
          });

    const entities = await this.namedEntities({
      userId,
      query: request.q ?? null,
      enabled: settings['entities.recallProfileEnabled'],
      maxChars: Math.floor(maxChars * ENTITY_BUDGET_SHARE),
    });

    // Unread mail, ahead of everything else and independent of the query: a
    // message was addressed to this account, which is a stronger claim on the
    // first lines of a session than anything a search can rank. Reading it here
    // does not mark it read (ADR-047).
    const waiting = await unreadMessagesForRecall(
      { prisma: this.prisma, logger: this.logger, settings: this.settings },
      {
        userId,
        workspaceId: memoryWorkspaceId,
        limit: settings['memory.recallMessageLimit'],
      },
    );
    // An empty mailbox contributes nothing at all, not the sentence saying it
    // is empty: a recall is read by a model deciding what to do next, and
    // "Keine Post." at the top of every session is a line that only ever costs.
    const mail =
      waiting.length === 0
        ? { text: '', kept: [] }
        : renderMessages(waiting, 'inbox', Math.floor(maxChars * MESSAGE_BUDGET_SHARE));

    // A fact already answered in full above must not take a slot again below.
    // The same goes for an entity's own page: it is the answer, not a hit.
    const stated = new Set([
      ...facts.map((fact) => fact.documentId),
      ...entities.map((entity) => entity.id),
    ]);
    const ranked = hits
      .filter((hit) => !stated.has(hit.documentId))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    const entitiesText = entities.map((entity) => entity.text).join('\n\n');
    const factsText = renderFacts(facts, Math.floor(maxChars * FACT_BUDGET_SHARE));
    const { text, kept, truncated } = renderRecall(
      ranked,
      maxChars - factsText.length - entitiesText.length - mail.text.length,
    );

    return {
      query: request.q ?? null,
      project,
      facts,
      entities,
      messages: mail.kept,
      hits: kept,
      text: [mail.text, entitiesText, factsText, text]
        .filter((block) => block.length > 0)
        .join('\n\n'),
      truncated: truncated || mail.kept.length < waiting.length,
      tookMs: Date.now() - startedAt,
    };
  }

  /**
   * Profiles for the entities the question named (issue #47).
   *
   * Matched against the query text, not against the hits: the point is to
   * answer "what do we know about fpb2" before any searching happens, and a
   * profile assembled from what the search already found would only repeat it.
   *
   * Never throws. A recall that cannot answer with a profile still answers.
   */
  private async namedEntities(input: {
    userId: string;
    query: string | null;
    enabled: boolean;
    maxChars: number;
  }): Promise<MemoryRecallEntity[]> {
    if (!input.enabled || input.query === null || input.maxChars <= 0) return [];
    try {
      const registry = await this.entityRegistry.loadReadable(input.userId);
      const named = registry
        .filter((entity) => queryNamesEntity(input.query ?? '', entity.title, entity.aliases))
        // The longest name first: a question naming both "Exocortex" and
        // "Exocortex-Worker" means the more specific of the two.
        .sort((a, b) => b.title.length - a.title.length)
        .slice(0, MAX_RECALL_ENTITIES);

      const profiles: MemoryRecallEntity[] = [];
      let budget = input.maxChars;
      for (const entity of named) {
        const profile = await this.entityProfiles.profile(input.userId, entity.id);
        const text = profile.text.slice(0, budget);
        if (text.length === 0) break;
        budget -= text.length;
        profiles.push({ id: entity.id, title: entity.title, type: entity.type, text });
      }
      return profiles;
    } catch (error) {
      this.logger.warn('Recall could not resolve entities', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * What the memory holds to be true for this project (issue #46).
   *
   * Ahead of the hits and independent of the query on purpose. A session that
   * has just started asks nothing yet, and the answer it needs is not "here are
   * five notes that mention this directory" but "here is what is true here".
   *
   * Reads the memory workspace directly rather than through the search index:
   * these are not search results, there is no query to rank them against, and
   * they are already the answer.
   */
  private async currentFacts(input: {
    workspaceId: string;
    projectKey: string;
    readable: readonly { id: string }[];
    limit: number;
  }): Promise<MemoryRecallFact[]> {
    if (input.limit === 0) return [];
    if (!input.readable.some((workspace) => workspace.id === input.workspaceId)) return [];

    const rows = await this.prisma.memoryFact.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectKey: input.projectKey,
        status: 'CURRENT',
        document: { archivedAt: null },
      },
      orderBy: [{ confidence: 'desc' }, { lastConfirmedAt: 'desc' }],
      take: input.limit,
      select: {
        id: true,
        documentId: true,
        confirmations: true,
        lastConfirmedAt: true,
        document: { select: { title: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      statement: row.document.title,
      confirmations: row.confirmations,
      lastConfirmedAt: row.lastConfirmedAt.toISOString(),
    }));
  }

  /**
   * Writes one distilled note.
   *
   * Two documents can come into being here: the project page, which is created
   * once and then reused, and the note under it. Appending to today's note is
   * the mode a chat client wants -- a conversation produces several small
   * memories, and one page per thought buries the project page in stubs.
   */
  async remember(input: {
    userId: string;
    request: MemoryRememberRequest;
    correlationId: string;
  }): Promise<MemoryRememberResponse> {
    const workspaceId = this.requireMemoryWorkspace(
      (await this.settings.get())['memory.enabled'],
      await memoryWorkspaceFor(this.prisma, input.userId),
    );

    const project = normaliseProject(input.request.project);
    const projectPage = await this.findOrCreateProjectPage({
      workspaceId,
      userId: input.userId,
      project,
      correlationId: input.correlationId,
    });

    // A live caller means now; a capture replayed from a stored transcript
    // hands over the day the session actually ended.
    const now =
      input.request.occurredAt === undefined ? new Date() : new Date(input.request.occurredAt);
    const day = formatDay(now);
    const existing = input.request.appendToday
      ? await this.findTodaysNote(projectPage.id, day)
      : null;

    const body = renderNote({
      text: input.request.text,
      client: input.request.client,
      tags: input.request.tags,
      at: now,
      heading: existing !== null,
      title: input.request.title ?? null,
    });

    if (existing !== null) {
      await this.content.write({
        documentId: existing.id,
        userId: input.userId,
        request: { markdown: body, mode: 'append' },
        correlationId: input.correlationId,
        source: 'ai',
      });
      return {
        documentId: existing.id,
        workspaceId,
        title: existing.title,
        appended: true,
        url: this.documentUrl(workspaceId, existing.id),
      };
    }

    const title = `${day} ${input.request.title ?? 'Notiz'}`.slice(0, 300);
    const created = await this.documents.create({
      workspaceId,
      userId: input.userId,
      request: { type: 'PAGE', title, parentId: projectPage.id },
      correlationId: input.correlationId,
    });
    await this.content.write({
      documentId: created.id,
      userId: input.userId,
      request: { markdown: body, mode: 'replace' },
      correlationId: input.correlationId,
      source: 'ai',
    });

    return {
      documentId: created.id,
      workspaceId,
      title,
      appended: false,
      url: this.documentUrl(workspaceId, created.id),
    };
  }

  /**
   * Queues a finished session for distillation.
   *
   * Answers immediately and never throws for a reason the caller cannot fix:
   * this runs inside somebody's editor as a hook, and a memory that could not
   * be written must not turn into an error in a working session. A missing
   * workspace, a session too short to be worth keeping and a switched-off
   * feature all come back as `accepted: false` with a reason.
   */
  async capture(input: {
    userId: string;
    request: MemoryCaptureRequest;
    correlationId: string;
  }): Promise<MemoryCaptureResponse> {
    const workspaceId = await memoryWorkspaceFor(this.prisma, input.userId);
    const settings =
      workspaceId === null
        ? await this.settings.get()
        : await this.settings.getForWorkspace(workspaceId);

    if (!settings['memory.enabled']) {
      return { accepted: false, jobId: null, reason: 'memory_disabled' };
    }
    if (workspaceId === null) {
      return { accepted: false, jobId: null, reason: 'memory_workspace_not_configured' };
    }
    if (input.request.transcript.length < settings['memory.captureMinChars']) {
      return { accepted: false, jobId: null, reason: 'transcript_too_short' };
    }

    const project = normaliseProject(input.request.project);
    const jobId = await this.queues.enqueue(
      QUEUE_NAMES.memoryCapture,
      {
        correlationId: input.correlationId,
        workspaceId,
        userId: input.userId,
        project: projectLabel(project),
        projectKey: project,
        client: input.request.client,
        sessionId: input.request.sessionId ?? null,
        transcript: input.request.transcript,
        hint: input.request.hint ?? null,
        endedAt: input.request.endedAt ?? null,
      },
      // One attempt: distilling costs a model call, and the processor reports
      // its own failures instead of throwing, so a retry would only ever repeat
      // an infrastructure problem and pay for the prompt twice.
      { attempts: 1 },
    );

    this.logger.info('Session queued for memory capture', {
      correlationId: input.correlationId,
      workspaceId,
      project,
      client: input.request.client,
      transcriptChars: input.request.transcript.length,
    });

    return { accepted: true, jobId: jobId === '' ? null : jobId, reason: null };
  }

  private requireMemoryWorkspace(enabled: boolean, workspaceId: string | null): string {
    if (!enabled) {
      throw new AppError(
        'memory_unavailable',
        'The memory area is switched off for this deployment',
      );
    }
    if (workspaceId === null) {
      throw new AppError(
        'memory_unavailable',
        'This account has no memory workspace; mark one of its workspaces as the memory area',
      );
    }
    return workspaceId;
  }

  private async readableWorkspaces(userId: string): Promise<{ id: string; name: string }[]> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId, workspace: { archivedAt: null } },
      select: { workspace: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((membership) => membership.workspace);
  }

  /**
   * One query per workspace, merged into a single ranking.
   *
   * Two lists stapled together would be the wrong answer: the caller asks one
   * question and can read a handful of lines, so the best five hits overall are
   * what it needs, wherever they live.
   */
  private async searchAcross(input: {
    userId: string;
    query: string;
    workspaces: readonly { id: string; name: string }[];
    memoryWorkspaceId: string | null;
    project: string | null;
  }): Promise<MemoryHit[]> {
    const perWorkspace = await Promise.all(
      input.workspaces.map(async (workspace) => {
        try {
          const response = await this.search.search(workspace.id, input.userId, {
            q: input.query,
            limit: PER_WORKSPACE_LIMIT,
            includeArchived: false,
          });
          return response.results.map((result) =>
            this.toHit(result, workspace.name, input.memoryWorkspaceId, input.project),
          );
        } catch (error) {
          // One unreadable workspace must not take the whole recall down: the
          // caller asked a question, not for a membership audit.
          this.logger.warn('Recall skipped a workspace', {
            workspaceId: workspace.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      }),
    );
    return perWorkspace.flat();
  }

  /**
   * What a session that has only just started gets: the newest notes for its
   * project, or the newest notes overall when it named no project.
   */
  private async recentNotes(input: {
    userId: string;
    memoryWorkspaceId: string | null;
    project: string | null;
    workspaces: readonly { id: string; name: string }[];
  }): Promise<MemoryHit[]> {
    const memoryWorkspaceId = input.memoryWorkspaceId;
    if (memoryWorkspaceId === null) return [];
    const workspace = input.workspaces.find((entry) => entry.id === memoryWorkspaceId);
    if (workspace === undefined) return [];

    const projectPage =
      input.project === null
        ? null
        : await this.prisma.document.findFirst({
            where: {
              workspaceId: memoryWorkspaceId,
              parentId: null,
              title: projectLabel(input.project),
              archivedAt: null,
            },
            select: { id: true, title: true },
          });
    if (input.project !== null && projectPage === null) return [];

    const rows = await this.prisma.document.findMany({
      where: {
        workspaceId: memoryWorkspaceId,
        archivedAt: null,
        ...(projectPage === null ? { parentId: { not: null } } : { parentId: projectPage.id }),
        // The distilled layer answers above the notes, never among them
        // (issue #46). Without this a recall spends two of its five slots on
        // the `Fakten` page and on a fact it has already stated in full.
        memoryFact: { is: null },
        children: { none: { memoryFact: { isNot: null } } },
      },
      select: {
        id: true,
        title: true,
        updatedAt: true,
        content: { select: { plainText: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: RECENT_FALLBACK_LIMIT,
    });

    return rows.map((row, index) => ({
      documentId: row.id,
      workspaceId: memoryWorkspaceId,
      workspaceName: workspace.name,
      title: row.title,
      path: projectPage === null ? [] : [{ id: projectPage.id, title: projectPage.title }],
      snippet: snippetFrom(row.content?.plainText ?? ''),
      source: 'memory' as const,
      // Recency is the only ordering here, and the scores keep that order after
      // the common sort further up.
      score: RECENT_FALLBACK_LIMIT - index,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private toHit(
    result: SearchResult,
    workspaceName: string,
    memoryWorkspaceId: string | null,
    project: string | null,
  ): MemoryHit {
    const isMemory = result.workspaceId === memoryWorkspaceId;
    const inProject =
      project !== null && result.path.some((entry) => entry.title === projectLabel(project));
    const score =
      result.rank * (isMemory ? MEMORY_BOOST : 1) * (isMemory && inProject ? PROJECT_BOOST : 1);

    return {
      documentId: result.documentId,
      workspaceId: result.workspaceId,
      workspaceName,
      title: result.title,
      path: result.path,
      snippet: snippetFrom(result.snippet),
      source: isMemory ? 'memory' : 'knowledge',
      score,
      updatedAt: result.updatedAt,
    };
  }

  private async findOrCreateProjectPage(input: {
    workspaceId: string;
    userId: string;
    project: string;
    correlationId: string;
  }): Promise<{ id: string; title: string }> {
    const title = projectLabel(input.project);
    const existing = await this.prisma.document.findFirst({
      where: {
        workspaceId: input.workspaceId,
        parentId: null,
        title,
        archivedAt: null,
      },
      select: { id: true, title: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing !== null) return existing;

    const created = await this.documents.create({
      workspaceId: input.workspaceId,
      userId: input.userId,
      request: { type: 'PAGE', title },
      correlationId: input.correlationId,
    });
    await this.content.write({
      documentId: created.id,
      userId: input.userId,
      request: {
        markdown: `Automatisch angelegte Projektseite für \`${input.project}\`. Darunter hängen die Sitzungsnotizen der Agenten.\n`,
        mode: 'replace',
      },
      correlationId: input.correlationId,
      source: 'ai',
    });
    return { id: created.id, title: created.title };
  }

  private async findTodaysNote(
    projectPageId: string,
    day: string,
  ): Promise<{ id: string; title: string } | null> {
    return this.prisma.document.findFirst({
      where: {
        parentId: projectPageId,
        archivedAt: null,
        title: { startsWith: day },
      },
      select: { id: true, title: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  private documentUrl(workspaceId: string, documentId: string): string | null {
    try {
      return new URL(
        `/arbeitsbereich/${workspaceId}/seite/${documentId}`,
        this.env.APP_URL,
      ).toString();
    } catch {
      return null;
    }
  }
}

/**
 * Does this question name that entity?
 *
 * Word-bounded containment, not a substring test: `api` must not match inside
 * `rapide`, and a recall that prepends the wrong profile has spent a quarter of
 * its budget on the wrong subject. Reuses the matcher the extraction uses, so
 * "the query names it" and "the page mentions it" can never drift apart.
 */
export function queryNamesEntity(
  query: string,
  title: string,
  aliases: readonly string[],
): boolean {
  return (
    matchEntityAliases(
      query,
      [title, ...aliases].map((alias) => ({ entityId: 'q', alias })),
    ).length > 0
  );
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function snippetFrom(text: string): string {
  const flattened = text.replace(/\s+/g, ' ').trim();
  return flattened.length <= MAX_SNIPPET_CHARS
    ? flattened
    : `${flattened.slice(0, MAX_SNIPPET_CHARS)}…`;
}

/** The Markdown one `remember` call adds to a page. */
function renderNote(input: {
  text: string;
  client: string;
  tags: readonly string[];
  at: Date;
  heading: boolean;
  title: string | null;
}): string {
  const time = input.at.toISOString().slice(11, 16);
  const meta = [`Client: ${input.client}`, `Zeit: ${formatDay(input.at)} ${time}`];
  if (input.tags.length > 0) meta.push(`Schlagworte: ${input.tags.join(', ')}`);

  const head = input.heading ? `## ${time} ${input.title ?? 'Notiz'}\n\n` : '';
  return `${head}${meta.join(' · ')}\n\n${input.text.trim()}\n`;
}

/**
 * The hits as one block of German text, inside a character budget.
 *
 * Rendered here rather than in every caller: the injection hook pastes this
 * straight into a session's context and must not carry formatting logic that
 * can drift from what the API considers a memory.
 */
function renderRecall(
  hits: readonly MemoryHit[],
  maxChars: number,
): { text: string; kept: MemoryHit[]; truncated: boolean } {
  if (hits.length === 0) {
    return { text: 'Keine passenden Erinnerungen gefunden.', kept: [], truncated: false };
  }

  const kept: MemoryHit[] = [];
  const lines: string[] = [];
  let used = 0;
  let truncated = false;

  for (const hit of hits) {
    const location =
      hit.path.length === 0 ? hit.workspaceName : hit.path.map((entry) => entry.title).join(' > ');
    const block = `- **${hit.title}** (${hit.source === 'memory' ? 'Erinnerung' : 'Wissen'}, ${location}, id: ${hit.documentId})\n  ${hit.snippet}`;
    if (used + block.length > maxChars && kept.length > 0) {
      truncated = true;
      break;
    }
    lines.push(block);
    kept.push(hit);
    used += block.length + 1;
  }

  return { text: lines.join('\n'), kept, truncated };
}

/**
 * The facts as one block of German text, inside its own budget.
 *
 * Headed rather than merged into the list of hits: an agent reading this needs
 * to be able to tell "this is held to be true" from "this was written down
 * once", and the heading is the whole distinction.
 */
function renderFacts(facts: readonly MemoryRecallFact[], maxChars: number): string {
  if (facts.length === 0 || maxChars <= 0) return '';

  const lines: string[] = ['Stand der Dinge (verdichtet aus früheren Sitzungen):'];
  let used = lines[0]!.length;

  for (const fact of facts) {
    const confirmed = fact.lastConfirmedAt.slice(0, 10);
    const line = `- ${fact.statement} (${fact.confirmations}× bestätigt, zuletzt ${confirmed}, id: ${fact.documentId})`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }

  return lines.length === 1 ? '' : lines.join('\n');
}
