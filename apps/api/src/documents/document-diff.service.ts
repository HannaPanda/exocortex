import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canReadDocument,
  canRestoreSnapshot,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type DocumentDiffResponse,
  type RestoreSnapshotBlocksResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import {
  applyBlocksFromDocument,
  applyProseMirrorDocumentToState,
  describeBlockType,
  diffDocuments,
  EXOCORTEX_SCHEMA_VERSION,
  type ProseMirrorDocument,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';

import { DocumentSnapshotService } from './document-snapshot.service';

interface ComparableState {
  /** `null` for the page's current content. */
  snapshotId: string | null;
  createdAt: Date;
  yjsState: Uint8Array;
  schemaVersion: number;
}

/** The older of the two states is always a snapshot, and says so in its type. */
interface SnapshotState extends ComparableState {
  snapshotId: string;
}

/**
 * Comparing two states of a page, and taking single blocks back (issue #77).
 *
 * Separate from `DocumentSnapshotService` because the questions are different
 * ones: that service owns what a snapshot *is* and how a restore lands, this
 * one owns what changed between two of them. Both writes go through
 * `commitRestore` there, so there is still exactly one place that knows how a
 * restore reaches an open editing session.
 *
 * Nothing here reads a snapshot's bytes out to a client. A diff is derived
 * text and structure, which is the same thing the page itself shows the caller
 * anyway; the binary state stays on the server.
 */
@Injectable()
export class DocumentDiffService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly snapshots: DocumentSnapshotService,
  ) {}

  /** Loads a snapshot and refuses one that belongs to a different page. */
  private async loadSnapshot(documentId: string, snapshotId: string): Promise<SnapshotState> {
    const snapshot = await this.prisma.documentSnapshot.findUnique({
      where: { id: snapshotId },
      select: { id: true, documentId: true, yjsState: true, schemaVersion: true, createdAt: true },
    });
    if (snapshot === null || snapshot.documentId !== documentId)
      throw AppError.notFound('Snapshot');
    return {
      snapshotId: snapshot.id,
      createdAt: snapshot.createdAt,
      yjsState: snapshot.yjsState,
      schemaVersion: snapshot.schemaVersion,
    };
  }

  private async loadCurrent(documentId: string): Promise<ComparableState> {
    const content = await this.prisma.documentContent.findUnique({
      where: { documentId },
      select: { yjsState: true, schemaVersion: true, yjsUpdatedAt: true },
    });
    if (content === null) throw AppError.notFound('Document content');
    return {
      snapshotId: null,
      createdAt: content.yjsUpdatedAt,
      yjsState: content.yjsState,
      schemaVersion: content.schemaVersion,
    };
  }

  /**
   * Derives the ProseMirror content of one state.
   *
   * A state that does not derive is refused rather than reported as an empty
   * page: an empty page would show every block as removed, which is a diff
   * that is not merely incomplete but wrong. A full restore still works for
   * such a snapshot, because that one can fall back to the bytes.
   */
  private derive(state: ComparableState, documentId: string): ProseMirrorDocument {
    try {
      return yjsStateToProseMirrorJson(state.yjsState);
    } catch (error) {
      this.logger.warn('A state could not be derived for a diff', {
        documentId,
        snapshotId: state.snapshotId,
        schemaVersion: state.schemaVersion,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw AppError.validation('The stored state could not be derived into content');
    }
  }

  /**
   * Compares two states of the same page.
   *
   * The two are ordered by age before they are compared, so "added" always
   * means "present in the newer one". Which of them the caller named in the
   * path therefore does not change what the answer means.
   */
  async diff(input: {
    documentId: string;
    snapshotId: string;
    against: string;
    userId: string;
  }): Promise<DocumentDiffResponse> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const named = await this.loadSnapshot(input.documentId, input.snapshotId);

    /*
     * The page's current content is always the newer of the two, whatever the
     * timestamps say. A snapshot is a copy of a state that existed at or
     * before now, so it can never be the later one -- and its `createdAt` is
     * genuinely younger than `yjsUpdatedAt` in the ordinary case of a snapshot
     * taken without a write since, which is exactly the comparison somebody
     * asks for right after taking one. Age decides between two snapshots and
     * nowhere else.
     */
    let from: SnapshotState = named;
    let to: ComparableState;
    if (input.against === 'current') {
      to = await this.loadCurrent(input.documentId);
    } else {
      const second = await this.loadSnapshot(input.documentId, input.against);
      if (second.snapshotId === named.snapshotId) {
        throw AppError.validation('A snapshot cannot be compared with itself');
      }
      if (second.createdAt.getTime() < named.createdAt.getTime()) {
        from = second;
        to = named;
      } else {
        to = second;
      }
    }

    const diff = diffDocuments(
      this.derive(from, input.documentId),
      this.derive(to, input.documentId),
    );

    const warnings: string[] = [];
    for (const state of [from, to]) {
      if (state.schemaVersion === EXOCORTEX_SCHEMA_VERSION) continue;
      warnings.push(
        `Der Stand vom ${state.createdAt.toISOString()} wurde mit einer älteren Schemaversion gespeichert. Einzelne Blöcke können dadurch anders aussehen als damals.`,
      );
    }
    if (diff.truncated) {
      warnings.push('Die Seite hat mehr Blöcke, als der Vergleich anzeigt.');
    }

    return {
      documentId: input.documentId,
      fromSnapshotId: from.snapshotId,
      fromCreatedAt: from.createdAt.toISOString(),
      toSnapshotId: to.snapshotId,
      toCreatedAt: to.createdAt.toISOString(),
      blocks: diff.blocks.map((block) => ({
        ...block,
        nodeLabel: describeBlockType(block.nodeType),
      })),
      summary: diff.summary,
      truncated: diff.truncated,
      warnings,
    };
  }

  /**
   * Takes the named blocks of a snapshot back into the page's current content.
   *
   * Applied to what the page holds now, never to the state a diff was rendered
   * against, so two people undoing different blocks do not overwrite each
   * other's work with a stale whole-page state.
   */
  async restoreBlocks(input: {
    documentId: string;
    snapshotId: string;
    blockIds: string[];
    userId: string;
    correlationId: string;
  }): Promise<RestoreSnapshotBlocksResponse> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canRestoreSnapshot(context.role, context.document));

    const snapshot = await this.loadSnapshot(input.documentId, input.snapshotId);
    const current = await this.loadCurrent(input.documentId);

    const source = this.derive(snapshot, input.documentId);
    const currentContent = this.derive(current, input.documentId);
    const merged = applyBlocksFromDocument(currentContent, source, input.blockIds);

    if (merged.restored.length === 0 && merged.removed.length === 0) {
      throw AppError.validation('None of the requested blocks exist in either state');
    }

    const unchanged = JSON.stringify(merged.document) === JSON.stringify(currentContent);
    if (unchanged) {
      return {
        documentId: input.documentId,
        snapshotId: snapshot.snapshotId ?? input.snapshotId,
        snapshotBeforeId: null,
        restored: merged.restored,
        removed: merged.removed,
        missing: merged.missing,
        appliedToLiveSession: false,
      };
    }

    const applied = applyProseMirrorDocumentToState(current.yjsState, merged.document, 'replace');
    const live = await this.snapshots.commitRestore({
      documentId: input.documentId,
      workspaceId: context.workspaceId,
      userId: input.userId,
      correlationId: input.correlationId,
      currentState: current.yjsState,
      currentSchemaVersion: current.schemaVersion,
      nextState: applied.yjsState,
      nextSchemaVersion: EXOCORTEX_SCHEMA_VERSION,
      liveContent: merged.document,
      auditTargetId: input.snapshotId,
      auditMetadata: {
        documentId: input.documentId,
        partial: true,
        restoredBlockCount: merged.restored.length,
        removedBlockCount: merged.removed.length,
      },
    });

    this.logger.warn('Blocks restored from a snapshot', {
      documentId: input.documentId,
      snapshotId: input.snapshotId,
      correlationId: input.correlationId,
      restoredBlockCount: merged.restored.length,
      removedBlockCount: merged.removed.length,
      appliedToLiveSession: live.applied,
    });

    return {
      documentId: input.documentId,
      snapshotId: input.snapshotId,
      snapshotBeforeId: live.snapshotBeforeId,
      restored: merged.restored,
      removed: merged.removed,
      missing: merged.missing,
      appliedToLiveSession: live.applied,
    };
  }
}
