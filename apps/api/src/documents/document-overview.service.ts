import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canEditDocument,
  canReadDocument,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type DocumentOverviewResponse,
  type OverviewEntry,
  type OverviewState,
  QUEUE_NAMES,
  type RefreshDocumentOverviewResponse,
} from '@exocortex/contracts';
import {
  type OverviewChild,
  overviewInputHash,
  type PrismaClient,
  readOverviewChildren,
} from '@exocortex/database';
import { QueueRegistry } from '@exocortex/queue';

import { PRISMA, QUEUES } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

import { toIconColor } from './document-shape';

/**
 * Reading and refreshing an overview page (issue #53, ADR-028).
 *
 * The composition is derived, so nothing here writes a page: the read assembles
 * what the browser shows from the digest row and the tree, and the refresh only
 * enqueues the job that recomposes. The worker owns the model call and the row.
 */
@Injectable()
export class DocumentOverviewService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    private readonly access: WorkspaceAccessService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * What the page shows.
   *
   * Answers for every page, not only for an overview: a client asking about an
   * ordinary page gets `mode: 'off'` and an empty list rather than a 404, which
   * is what lets the panel be rendered unconditionally and disappear on its own.
   */
  async read(documentId: string, userId: string): Promise<DocumentOverviewResponse> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const [row, digest] = await Promise.all([
      this.prisma.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { overviewMode: true, title: true, content: { select: { markdown: true } } },
      }),
      this.prisma.documentDigest.findUnique({ where: { documentId } }),
    ]);

    if (row.overviewMode === 'OFF') {
      return {
        documentId,
        mode: 'off',
        state: 'off',
        intro: null,
        generatedAt: null,
        model: null,
        stale: false,
        error: null,
        entries: [],
      };
    }

    const children = await readOverviewChildren(this.prisma, documentId);
    const settings = await this.settings.getForWorkspace(context.workspaceId);
    const composable = settings['ai.enabled'] && settings['overview.enabled'];
    // Capped exactly as the worker caps it. The hash is compared against one
    // the worker wrote, and a page longer than the cap would otherwise hash
    // differently here and show as stale for ever.
    const liveHash = overviewInputHash({
      title: row.title,
      ownText: (row.content?.markdown ?? '').slice(0, settings['overview.maxPageChars']),
      children,
    });

    return {
      documentId,
      mode: 'auto',
      state: overviewState({ intro: digest?.intro ?? null, composable }),
      intro: digest?.intro ?? null,
      generatedAt: digest?.introAt?.toISOString() ?? null,
      model: digest?.model ?? null,
      // A composition nobody has run yet is not stale, it is missing; saying
      // both would put a "veraltet" badge on a page that never had a version.
      stale: digest?.intro != null && digest.introInputHash !== liveHash,
      error: digest?.lastError ?? null,
      entries: children.map(toEntry),
    };
  }

  /**
   * Recomposes now, skipping the debounce and the unchanged-hash shortcut.
   *
   * Refuses while the deployment cannot compose at all, and says which switch
   * is off: a button that queues a job which will silently do nothing is a
   * button that lies.
   */
  async requestRefresh(input: {
    documentId: string;
    userId: string;
    correlationId: string;
  }): Promise<RefreshDocumentOverviewResponse> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));

    const row = await this.prisma.document.findUniqueOrThrow({
      where: { id: input.documentId },
      select: { overviewMode: true },
    });
    if (row.overviewMode === 'OFF') {
      return {
        status: 'skipped',
        documentId: input.documentId,
        reason: 'Diese Seite ist keine Übersichtsseite.',
      };
    }

    const settings = await this.settings.getForWorkspace(context.workspaceId);
    if (!settings['overview.enabled']) {
      return {
        status: 'skipped',
        documentId: input.documentId,
        reason: 'Übersichtsseiten sind für diesen Arbeitsbereich abgeschaltet.',
      };
    }
    if (!settings['ai.enabled']) {
      return {
        status: 'skipped',
        documentId: input.documentId,
        reason: 'Die KI ist für diese Installation abgeschaltet.',
      };
    }

    await this.enqueue({
      documentId: input.documentId,
      workspaceId: context.workspaceId,
      correlationId: input.correlationId,
      reason: 'requested',
      force: true,
    });
    return { status: 'pending', documentId: input.documentId, reason: null };
  }

  /**
   * Queues a refresh without asking anything.
   *
   * For the callers that already know the page should be composed -- marking a
   * page as an overview, and the maintenance sweep. Immediate rather than
   * debounced: both are deliberate acts, and a page that has just been marked
   * should not sit blank for five minutes.
   */
  async enqueue(input: {
    documentId: string;
    workspaceId: string;
    correlationId: string;
    reason: 'marked' | 'requested' | 'sweep';
    force: boolean;
  }): Promise<void> {
    await this.queues.enqueue(QUEUE_NAMES.documentOverview, {
      correlationId: input.correlationId,
      documentId: input.documentId,
      workspaceId: input.workspaceId,
      reason: input.reason,
      force: input.force,
      depth: 0,
    });
  }
}

function overviewState(input: { intro: string | null; composable: boolean }): OverviewState {
  if (input.intro !== null) return 'ready';
  return input.composable ? 'pending' : 'unavailable';
}

function toEntry(child: OverviewChild): OverviewEntry {
  return {
    documentId: child.id,
    title: child.title,
    icon: child.icon,
    iconColor: toIconColor(child.iconColor),
    type: child.type,
    isOverview: child.isOverview,
    summary: child.summary,
    childCount: child.childCount,
  };
}
