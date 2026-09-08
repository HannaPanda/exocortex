import { Inject, Injectable } from '@nestjs/common';

import { type AgentRevertSkipReason, type AgentSessionRevertResponse } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { LOGGER } from '../common/logger.provider';
import { DocumentSnapshotService } from '../documents/document-snapshot.service';
import { PRISMA } from '../platform/platform.module';

/**
 * How long after a session's last write on a page a change still counts as
 * that write's own echo.
 *
 * A write through the API is handed to the collaboration server afterwards
 * (ADR-016), and that server persists it again a moment later under its own
 * timestamp. Without a grace period every single write would therefore look
 * like "somebody edited this afterwards" and no revert would ever proceed.
 *
 * Two minutes is far longer than the echo needs and short enough that a person
 * who sat down to edit the page is outside it. The trade is deliberate and it
 * is the one dangerous number in this file: an edit made inside the window,
 * by a human, is overwritten by the revert without being named.
 */
const LIVE_ECHO_GRACE_MS = 2 * 60 * 1000;

interface PageToRevert {
  documentId: string;
  documentTitle: string | null;
  snapshotId: string;
  lastWriteAt: Date;
}

/**
 * Taking a whole agent session back (issue #49, ADR-022).
 *
 * The operation the write journal exists for. It is not a transaction and
 * cannot be one: each page goes back through the ordinary snapshot restore, so
 * that the open editing session is told (ADR-016), the change is materialized,
 * and the restore is audited exactly as a manual one would be. Half of it
 * succeeding is therefore a real outcome, which is why the answer names every
 * page it did not touch and why.
 *
 * What it reverts to is the state before the session's *first snapshotted*
 * write on each page, not before the last: a session that rewrote the same
 * page four times is one intervention, and undoing only the fourth would leave
 * the other three standing. Writes that took no snapshot -- a rename, a move --
 * are earlier than nothing this can reach, and the answer says so.
 */
@Injectable()
export class AgentSessionRevertService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly snapshots: DocumentSnapshotService,
  ) {}

  async revert(input: {
    sessionId: string;
    userId: string;
    correlationId: string;
  }): Promise<AgentSessionRevertResponse> {
    const writes = await this.prisma.agentWriteJournal.findMany({
      where: { sessionId: input.sessionId },
      orderBy: { createdAt: 'asc' },
      select: {
        documentId: true,
        documentTitle: true,
        snapshotBeforeId: true,
        createdAt: true,
      },
    });

    const { pages, skipped } = groupPages(writes);
    const reverted: AgentSessionRevertResponse['reverted'] = [];

    for (const page of pages) {
      const reason = await this.blockedBecause(page, input.sessionId);
      if (reason !== null) {
        skipped.push({
          documentId: page.documentId,
          documentTitle: page.documentTitle,
          reason,
        });
        continue;
      }

      try {
        await this.snapshots.restore({
          snapshotId: page.snapshotId,
          userId: input.userId,
          correlationId: input.correlationId,
        });
        reverted.push({
          documentId: page.documentId,
          documentTitle: page.documentTitle,
          snapshotId: page.snapshotId,
        });
      } catch (error) {
        // A page that cannot be restored -- deleted, or not this caller's to
        // edit -- must not take the rest of the session with it.
        this.logger.warn('Agent session revert skipped a page', {
          agentSessionId: input.sessionId,
          documentId: page.documentId,
          correlationId: input.correlationId,
          reason: error instanceof Error ? error.message : String(error),
        });
        skipped.push({
          documentId: page.documentId,
          documentTitle: page.documentTitle,
          reason: 'unavailable',
        });
      }
    }

    this.logger.warn('Agent session reverted', {
      agentSessionId: input.sessionId,
      correlationId: input.correlationId,
      reverted: reverted.length,
      skipped: skipped.length,
    });
    return { reverted, skipped };
  }

  /**
   * Whether somebody else has been here since, and the page must be left alone.
   *
   * Two independent signals, because they catch different writers: another
   * agent session shows up in the journal, and a person typing in the editor
   * shows up only as a moved `yjsUpdatedAt` (their edits never pass through
   * the API at all).
   */
  private async blockedBecause(
    page: PageToRevert,
    sessionId: string,
  ): Promise<AgentRevertSkipReason | null> {
    const [foreignWrite, content] = await Promise.all([
      this.prisma.agentWriteJournal.findFirst({
        where: {
          documentId: page.documentId,
          sessionId: { not: sessionId },
          createdAt: { gt: page.lastWriteAt },
        },
        select: { id: true },
      }),
      this.prisma.documentContent.findUnique({
        where: { documentId: page.documentId },
        select: { yjsUpdatedAt: true },
      }),
    ]);

    if (foreignWrite !== null) return 'changed_since';
    if (content === null) return 'unavailable';
    if (content.yjsUpdatedAt.getTime() > page.lastWriteAt.getTime() + LIVE_ECHO_GRACE_MS) {
      return 'changed_since';
    }
    return null;
  }
}

/**
 * Folds the journal into one entry per page: the snapshot before the session's
 * first write, and the time of its last.
 *
 * The two ends are needed for different questions. The first write says where
 * back is; the last says what "changed since" is measured against, because a
 * change between two writes of the same session is still this session's doing.
 */
function groupPages(
  writes: readonly {
    documentId: string;
    documentTitle: string | null;
    snapshotBeforeId: string | null;
    createdAt: Date;
  }[],
): { pages: PageToRevert[]; skipped: AgentSessionRevertResponse['skipped'] } {
  const pages = new Map<string, PageToRevert>();
  const withoutSnapshot = new Map<string, string | null>();

  for (const write of writes) {
    const existing = pages.get(write.documentId);
    if (existing !== undefined) {
      existing.lastWriteAt = write.createdAt;
      if (write.documentTitle !== null) existing.documentTitle = write.documentTitle;
      continue;
    }
    if (write.snapshotBeforeId === null) {
      // Remembered, not discarded: a session that only renamed a page still has
      // to appear in the answer, saying that a rename is not something this
      // takes back.
      if (!withoutSnapshot.has(write.documentId)) {
        withoutSnapshot.set(write.documentId, write.documentTitle);
      }
      continue;
    }
    pages.set(write.documentId, {
      documentId: write.documentId,
      documentTitle: write.documentTitle,
      snapshotId: write.snapshotBeforeId,
      lastWriteAt: write.createdAt,
    });
  }

  const skipped: AgentSessionRevertResponse['skipped'] = [];
  for (const [documentId, documentTitle] of withoutSnapshot) {
    if (pages.has(documentId)) continue;
    skipped.push({ documentId, documentTitle, reason: 'no_snapshot' });
  }

  return { pages: [...pages.values()], skipped };
}
