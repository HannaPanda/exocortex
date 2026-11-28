import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canReadDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type DocumentDiffNotice,
  type PageHistoryResponse,
  type SnapshotContentResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import {
  currentContentOfState,
  EXOCORTEX_SCHEMA_VERSION,
  serializeMarkdown,
} from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';

import { SNAPSHOT_REASON_MAP } from './document-snapshot.service';
import { groupVersions, toVersion, type VersionJournal, type VersionRow } from './page-history';
import { applyResponseBudget } from './response-budget';

const VERSION_SELECT = {
  id: true,
  createdAt: true,
  reason: true,
  createdById: true,
  createdBy: { select: { name: true } },
} as const;

/**
 * The page history of issue #235: a page's stored versions with their authors,
 * grouped, and any one of them readable.
 *
 * Reading only. Restoring stays on `DocumentSnapshotService`, so there is still
 * one place that knows how a restore saves the current state first and reaches
 * an open editing session (ADR-016); comparing stays on `DocumentDiffService`.
 */
@Injectable()
export class PageHistoryService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
  ) {}

  private async requireRead(documentId: string, userId: string): Promise<void> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));
  }

  /** The journal rows of the writes these snapshots were taken before, by snapshot id. */
  private async journals(
    documentId: string,
    snapshotIds: readonly string[],
  ): Promise<Map<string, VersionJournal>> {
    if (snapshotIds.length === 0) return new Map();
    const rows = await this.prisma.agentWriteJournal.findMany({
      // `documentId` first, which is what the index covers.
      where: { documentId, snapshotBeforeId: { in: [...snapshotIds] } },
      select: {
        snapshotBeforeId: true,
        actorId: true,
        session: { select: { id: true, externalId: true, clientLabel: true } },
      },
    });
    const byId = new Map<string, VersionJournal>();
    for (const row of rows) {
      if (row.snapshotBeforeId === null) continue;
      byId.set(row.snapshotBeforeId, {
        actorId: row.actorId,
        agentSessionId: row.session.id,
        externalId: row.session.externalId,
        clientLabel: row.session.clientLabel,
      });
    }
    return byId;
  }

  async history(input: {
    documentId: string;
    userId: string;
    before?: string;
    limit: number;
  }): Promise<PageHistoryResponse> {
    await this.requireRead(input.documentId, input.userId);

    const [content, snapshots] = await Promise.all([
      this.prisma.documentContent.findUnique({
        where: { documentId: input.documentId },
        select: { yjsUpdatedAt: true },
      }),
      // Metadata only: the bytes stay on the server, and loading them for a
      // list of three hundred would be megabytes nobody reads.
      this.prisma.documentSnapshot.findMany({
        where: {
          documentId: input.documentId,
          ...(input.before === undefined ? {} : { createdAt: { lt: new Date(input.before) } }),
        },
        orderBy: { createdAt: 'desc' },
        take: input.limit + 1,
        select: VERSION_SELECT,
      }),
    ]);
    if (content === null) throw AppError.notFound('Document content');

    const page = snapshots.slice(0, input.limit);
    const journals = await this.journals(
      input.documentId,
      page.map((snapshot) => snapshot.id),
    );
    const rows: VersionRow[] = page.map((snapshot) => ({
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      reason: SNAPSHOT_REASON_MAP[snapshot.reason],
      createdById: snapshot.createdById,
      createdByName: snapshot.createdBy?.name ?? null,
      journal: journals.get(snapshot.id) ?? null,
    }));
    const last = page[page.length - 1];

    return {
      documentId: input.documentId,
      currentUpdatedAt: content.yjsUpdatedAt.toISOString(),
      groups: groupVersions(rows),
      versionCount: rows.length,
      nextBefore:
        snapshots.length > input.limit && last !== undefined ? last.createdAt.toISOString() : null,
    };
  }

  /**
   * One version, as Markdown and, on request, as the ProseMirror JSON the
   * browser renders. Over `maxChars` the answer is the version's map and no
   * text (ADR-056), the same rule every other read follows.
   */
  async read(input: {
    documentId: string;
    snapshotId: string;
    userId: string;
    maxChars?: number;
    withContent: boolean;
  }): Promise<SnapshotContentResponse> {
    await this.requireRead(input.documentId, input.userId);

    const snapshot = await this.prisma.documentSnapshot.findUnique({
      where: { id: input.snapshotId },
      select: { ...VERSION_SELECT, documentId: true, yjsState: true, schemaVersion: true },
    });
    if (snapshot === null || snapshot.documentId !== input.documentId) {
      throw AppError.notFound('Snapshot');
    }

    let document;
    try {
      document = currentContentOfState(snapshot.yjsState, snapshot.schemaVersion);
    } catch (error) {
      this.logger.warn('A stored version could not be derived for reading', {
        documentId: input.documentId,
        snapshotId: snapshot.id,
        schemaVersion: snapshot.schemaVersion,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw AppError.validation('The stored state could not be derived into content');
    }

    const journal = (await this.journals(input.documentId, [snapshot.id])).get(snapshot.id);
    const version = toVersion({
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      reason: SNAPSHOT_REASON_MAP[snapshot.reason],
      createdById: snapshot.createdById,
      createdByName: snapshot.createdBy?.name ?? null,
      journal: journal ?? null,
    });

    const budgeted = applyResponseBudget(document, serializeMarkdown(document), {
      maxChars: input.maxChars,
    });
    const notices: DocumentDiffNotice[] =
      snapshot.schemaVersion < EXOCORTEX_SCHEMA_VERSION
        ? [{ code: 'older_schema', stateCreatedAt: snapshot.createdAt.toISOString() }]
        : [];

    return {
      documentId: input.documentId,
      version,
      view: budgeted.view,
      chars: budgeted.chars,
      markdown: budgeted.markdown,
      map: budgeted.map,
      proseMirrorJson: input.withContent && budgeted.view === 'content' ? document : null,
      notices,
    };
  }
}
