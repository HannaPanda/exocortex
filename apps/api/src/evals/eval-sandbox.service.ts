import { Inject, Injectable } from '@nestjs/common';

import { type EvalFixture } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { serializeMarkdown, yjsStateToProseMirrorJson } from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';

import { LOGGER } from '../common/logger.provider';
import { DocumentContentService } from '../documents/document-content.service';
import { DocumentsService } from '../documents/documents.service';
import { PRISMA } from '../platform/platform.module';

/** Characters of one page an attempt keeps; the row stays bounded however much a run wrote. */
const MAX_KEPT_PAGE_CHARS = 60_000;
/** Pages a run created that an attempt keeps the text of. */
const MAX_KEPT_CREATED_PAGES = 20;

/** Where a fixture page went, and what it read right after it was copied in. */
export interface SandboxPage {
  id: string;
  baseline: string;
}

export interface BuiltSandbox {
  rootId: string;
  pages: Record<string, SandboxPage>;
  /** The page the run stands on: the fixture's start page, or the sandbox itself. */
  startId: string;
}

export interface SandboxReading {
  /** Final text by fixture key; null for a page the run deleted. */
  pages: Record<string, string | null>;
  changedPages: number;
  createdPages: { title: string; markdown: string }[];
  createdCount: number;
  truncated: boolean;
}

/**
 * The pages a fixture attempt works on (issue #146, ADR-074).
 *
 * Built with the ordinary services, as the person who started the eval, so a
 * sandbox is nothing but pages: the run reaches it through the same routes
 * as any other page, and only its credential is confined to it. The pages
 * hang under one page per eval run, so a run of many attempts adds one page
 * to the top of the tree rather than one per attempt; both go once their
 * text has been kept.
 */
@Injectable()
export class EvalSandboxService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly documents: DocumentsService,
    private readonly content: DocumentContentService,
  ) {}

  /** The page an eval run's sandboxes hang under, created by the first that needs it. */
  async container(input: {
    evalRunId: string;
    workspaceId: string;
    userId: string;
    title: string;
    correlationId: string;
  }): Promise<string> {
    const run = await this.prisma.evalRun.findUniqueOrThrow({
      where: { id: input.evalRunId },
      select: { sandboxDocumentId: true },
    });
    if (run.sandboxDocumentId !== null) {
      const live = await this.prisma.document.findUnique({
        where: { id: run.sandboxDocumentId },
        select: { id: true },
      });
      if (live !== null) return live.id;
    }
    const created = await this.documents.create({
      workspaceId: input.workspaceId,
      userId: input.userId,
      correlationId: input.correlationId,
      request: { title: input.title.slice(0, 300), parentId: null, type: 'PAGE' },
    });
    // Recorded before anything is written into it, so the automation filter
    // knows the page before its first event is dispatched.
    await this.prisma.evalRun.update({
      where: { id: input.evalRunId },
      data: { sandboxDocumentId: created.id },
    });
    return created.id;
  }

  async build(input: {
    attemptId: string;
    workspaceId: string;
    userId: string;
    containerId: string;
    title: string;
    fixture: EvalFixture;
    correlationId: string;
  }): Promise<BuiltSandbox> {
    const root = await this.documents.create({
      workspaceId: input.workspaceId,
      userId: input.userId,
      correlationId: input.correlationId,
      request: { title: input.title.slice(0, 300), parentId: input.containerId, type: 'PAGE' },
    });
    await this.prisma.evalAttempt.update({
      where: { id: input.attemptId },
      data: { sandboxDocumentId: root.id },
    });

    const pages: Record<string, SandboxPage> = {};
    for (const page of input.fixture.pages) {
      const parentId = page.parentKey === null ? root.id : pages[page.parentKey]!.id;
      const created = await this.documents.create({
        workspaceId: input.workspaceId,
        userId: input.userId,
        correlationId: input.correlationId,
        request: { title: page.title, parentId, type: 'PAGE' },
      });
      if (page.markdown.trim().length > 0) {
        await this.content.write({
          documentId: created.id,
          userId: input.userId,
          correlationId: input.correlationId,
          request: { markdown: page.markdown, mode: 'replace' },
          source: 'api',
          // Internal: the fixture is the case's own text, not an agent's growth.
          growth: 'exempt',
        });
      }
      pages[page.key] = { id: created.id, baseline: (await this.readText(created.id)) ?? '' };
    }
    const startKey = input.fixture.startKey;
    return { rootId: root.id, pages, startId: startKey === null ? root.id : pages[startKey]!.id };
  }

  /** What the sandbox holds now, against what was copied in. */
  async read(input: {
    rootId: string;
    pages: Readonly<Record<string, SandboxPage>>;
  }): Promise<SandboxReading> {
    let truncated = false;
    const keep = (text: string): string => {
      if (text.length <= MAX_KEPT_PAGE_CHARS) return text;
      truncated = true;
      return text.slice(0, MAX_KEPT_PAGE_CHARS);
    };

    const finals: Record<string, string | null> = {};
    let changedPages = 0;
    for (const [key, page] of Object.entries(input.pages)) {
      const text = await this.readText(page.id);
      if (text === null || text !== page.baseline) changedPages += 1;
      finals[key] = text === null ? null : keep(text);
    }

    const known = new Set([input.rootId, ...Object.values(input.pages).map((page) => page.id)]);
    const subtree = await this.subtree(input.rootId);
    const created = subtree.filter((row) => !known.has(row.id));
    const createdPages: SandboxReading['createdPages'] = [];
    for (const row of created.slice(0, MAX_KEPT_CREATED_PAGES)) {
      createdPages.push({ title: row.title, markdown: keep((await this.readText(row.id)) ?? '') });
    }
    if (created.length > MAX_KEPT_CREATED_PAGES) truncated = true;
    return {
      pages: finals,
      changedPages,
      createdPages,
      createdCount: created.length,
      truncated,
    };
  }

  /** Deletes a sandbox or a container for good; one already gone is fine. */
  async destroy(input: {
    documentId: string;
    userId: string;
    correlationId: string;
  }): Promise<void> {
    const exists = await this.prisma.document.findUnique({
      where: { id: input.documentId },
      select: { id: true, archivedAt: true },
    });
    if (exists === null) return;
    try {
      // Only a page in the trash can be deleted for good, as anywhere else.
      if (exists.archivedAt === null) {
        await this.documents.archive({
          documentId: input.documentId,
          userId: input.userId,
          correlationId: input.correlationId,
        });
      }
      await this.documents.deletePermanently({
        documentIds: [input.documentId],
        userId: input.userId,
        correlationId: input.correlationId,
      });
    } catch (error) {
      // A sandbox left behind is visible and deletable by hand; failing the
      // settlement over it would lose the measurement.
      this.logger.warn('Could not delete an eval sandbox', {
        documentId: input.documentId,
        reason: error instanceof Error ? error.message : String(error),
        correlationId: input.correlationId,
      });
    }
  }

  /** A page's text as Markdown without frontmatter, read from its canonical state. */
  private async readText(documentId: string): Promise<string | null> {
    const row = await this.prisma.documentContent.findUnique({
      where: { documentId },
      select: { yjsState: true, document: { select: { archivedAt: true } } },
    });
    if (row === null || row.document.archivedAt !== null) return null;
    return serializeMarkdown(yjsStateToProseMirrorJson(row.yjsState)).trim();
  }

  /** Every live page under the root, root excluded, walked breadth first. */
  private async subtree(rootId: string): Promise<{ id: string; title: string }[]> {
    const found: { id: string; title: string }[] = [];
    let frontier = [rootId];
    for (let depth = 0; depth < 20 && frontier.length > 0; depth += 1) {
      const rows = await this.prisma.document.findMany({
        where: { parentId: { in: frontier }, archivedAt: null },
        select: { id: true, title: true },
        orderBy: { createdAt: 'asc' },
      });
      found.push(...rows);
      frontier = rows.map((row) => row.id);
    }
    return found;
  }
}
