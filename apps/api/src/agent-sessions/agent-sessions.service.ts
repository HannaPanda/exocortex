import { Inject, Injectable } from '@nestjs/common';

import {
  type AgentSession,
  type AgentSessionDetailResponse,
  type AgentSessionListResponse,
  type AgentWrite,
  type RegisterAgentSessionRequest,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';

import { AgentSessionRevertService } from './agent-session-revert.service';

/** How many sessions a list answers with. Older ones age out anyway. */
const MAX_SESSIONS = 100;

/** How many journal rows one session's detail view carries. */
const MAX_WRITES = 500;

const SESSION_SELECT = {
  id: true,
  externalId: true,
  clientLabel: true,
  transport: true,
  userId: true,
  startedAt: true,
  lastSeenAt: true,
  user: { select: { name: true } },
} as const;

/**
 * What one agent connection did (issue #49, ADR-022).
 *
 * The reading half of provenance. The writing half is in `OutboxService`,
 * because a journal that is not written inside the transaction that changed
 * the data is a journal that eventually disagrees with it; the taking-back
 * half is `AgentSessionRevertService`, because it is a different kind of
 * operation altogether -- partial, not atomic, and it has to answer honestly
 * about what it could not touch.
 *
 * Who may see what: a caller sees their own sessions, a global admin sees
 * every session. That is not a courtesy to the admin, it is the point -- the
 * question "what did the agent do last night" is usually asked by the person
 * who owns the deployment, not by the account the agent ran as.
 */
@Injectable()
export class AgentSessionsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly revertService: AgentSessionRevertService,
  ) {}

  /**
   * Records a connection as it announces itself at `initialize`.
   *
   * An upsert, and deliberately forgiving: the same client reconnecting with
   * the same id is the same working session, and a session that was never
   * announced at all is created by the first write it makes anyway. What this
   * call adds is the label -- nothing else knows what the thing on the other
   * end calls itself.
   */
  async register(
    userId: string,
    request: RegisterAgentSessionRequest,
  ): Promise<{ id: string; externalId: string }> {
    const session = await this.prisma.agentSession.upsert({
      where: { userId_externalId: { userId, externalId: request.externalId } },
      create: {
        userId,
        externalId: request.externalId,
        clientLabel: request.clientLabel ?? null,
        transport: request.transport ?? null,
      },
      update: {
        lastSeenAt: new Date(),
        // A reconnect may know more than the first connect did; it may also
        // know less, and a label already recorded is not overwritten with
        // nothing.
        ...(request.clientLabel === undefined ? {} : { clientLabel: request.clientLabel }),
        ...(request.transport === undefined ? {} : { transport: request.transport }),
      },
      select: { id: true, externalId: true },
    });

    this.logger.debug('Agent session announced', {
      agentSessionId: session.id,
      clientLabel: request.clientLabel,
      transport: request.transport,
    });
    return session;
  }

  async list(userId: string): Promise<AgentSessionListResponse> {
    const scopeToOwner = !(await this.isGlobalAdmin(userId));
    const rows = await this.prisma.agentSession.findMany({
      where: scopeToOwner ? { userId } : {},
      orderBy: { lastSeenAt: 'desc' },
      take: MAX_SESSIONS,
      select: SESSION_SELECT,
    });

    const summaries = await this.summarize(rows.map((row) => row.id));
    return { sessions: rows.map((row) => toSession(row, summaries.get(row.id))) };
  }

  async detail(sessionId: string, userId: string): Promise<AgentSessionDetailResponse> {
    const session = await this.require(sessionId, userId);
    const writes = await this.prisma.agentWriteJournal.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: MAX_WRITES,
      select: {
        id: true,
        documentId: true,
        documentTitle: true,
        action: true,
        snapshotBeforeId: true,
        correlationId: true,
        createdAt: true,
      },
    });

    const summaries = await this.summarize([session.id]);
    return {
      session: toSession(session, summaries.get(session.id)),
      writes: writes.map((write): AgentWrite => ({
        id: write.id,
        documentId: write.documentId,
        documentTitle: write.documentTitle,
        action: write.action,
        snapshotBeforeId: write.snapshotBeforeId,
        correlationId: write.correlationId,
        createdAt: write.createdAt.toISOString(),
      })),
    };
  }

  /** See `AgentSessionRevertService.revert`. */
  async revert(sessionId: string, userId: string, correlationId: string) {
    const session = await this.require(sessionId, userId);
    return this.revertService.revert({ sessionId: session.id, userId, correlationId });
  }

  /**
   * Loads a session the caller is allowed to see, or refuses.
   *
   * A session somebody else owns and this caller may not see is reported as
   * missing rather than forbidden: whether an account of yours has an agent
   * running is not a thing a stranger gets to learn from an error code.
   */
  private async require(sessionId: string, userId: string) {
    const session = await this.prisma.agentSession.findUnique({
      where: { id: sessionId },
      select: SESSION_SELECT,
    });
    if (session === null) throw AppError.notFound('Agent session');
    if (session.userId !== userId && !(await this.isGlobalAdmin(userId))) {
      throw AppError.notFound('Agent session');
    }
    return session;
  }

  /**
   * How much each session did, without reading its rows.
   *
   * One grouped query rather than a count per session: the list is a hundred
   * sessions wide and a query each would make opening the page cost a hundred
   * round-trips. Grouping by page as well as by session is what yields the
   * distinct-page count -- "touched eleven pages" is the number a person
   * judges a session by, not "made ninety writes".
   */
  private async summarize(sessionIds: readonly string[]): Promise<Map<string, WriteSummary>> {
    const summaries = new Map<string, WriteSummary>();
    if (sessionIds.length === 0) return summaries;

    const perDocument = await this.prisma.agentWriteJournal.groupBy({
      by: ['sessionId', 'documentId'],
      where: { sessionId: { in: [...sessionIds] } },
      _count: { _all: true },
      _max: { snapshotBeforeId: true },
    });

    for (const row of perDocument) {
      const summary = summaries.get(row.sessionId) ?? {
        writeCount: 0,
        documentCount: 0,
        revertable: false,
      };
      summary.writeCount += row._count._all;
      summary.documentCount += 1;
      // `_max` over a nullable column is null exactly when every row in the
      // group is null, which is the question being asked: did this session
      // leave anything on this page that a revert could go back to.
      if (row._max.snapshotBeforeId !== null) summary.revertable = true;
      summaries.set(row.sessionId, summary);
    }
    return summaries;
  }

  private async isGlobalAdmin(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return user?.role === 'ADMIN';
  }
}

interface SessionRow {
  id: string;
  externalId: string;
  clientLabel: string | null;
  transport: string | null;
  userId: string;
  startedAt: Date;
  lastSeenAt: Date;
  user: { name: string } | null;
}

interface WriteSummary {
  writeCount: number;
  documentCount: number;
  revertable: boolean;
}

function toSession(row: SessionRow, summary: WriteSummary | undefined): AgentSession {
  return {
    id: row.id,
    externalId: row.externalId,
    clientLabel: row.clientLabel,
    transport: row.transport,
    userId: row.userId,
    userName: row.user?.name ?? null,
    startedAt: row.startedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    writeCount: summary?.writeCount ?? 0,
    documentCount: summary?.documentCount ?? 0,
    // A session whose every write was a rename or a move has nothing to go
    // back to, and the list should say so before somebody presses the button.
    revertable: summary?.revertable ?? false,
  };
}
