import { Inject, Injectable } from '@nestjs/common';

import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { currentAgentSession, currentAiRunId, currentCorrelationId } from '../common/correlation';
import { LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * Tells the workspace that an external agent read a page (issue #189).
 *
 * The knowledge map lights a point up while something reads it. The built-in
 * AI's reads already arrive as `ai.run.tool_call` from the worker; an agent
 * over MCP reaches the API directly and left no trace, so its reads were
 * invisible while its writes lit up. Called after a read has succeeded, and
 * only when the request named an agent session (ADR-022) and no run of the
 * built-in AI made it, so nothing is announced twice and a person reading in
 * the browser is never announced at all.
 *
 * Never throws and is never awaited by the read: a notice that fails must not
 * cost the agent its answer.
 */
@Injectable()
export class AgentReadNoticeService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly realtime: RealtimeService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  announce(documentId: string): void {
    const agent = currentAgentSession();
    if (agent === undefined || currentAiRunId() !== undefined) return;
    const correlationId = currentCorrelationId();
    void this.send(documentId, agent.clientLabel ?? null, correlationId);
  }

  private async send(
    documentId: string,
    clientLabel: string | null,
    correlationId: string,
  ): Promise<void> {
    try {
      const document = await this.prisma.document.findUnique({
        where: { id: documentId },
        select: { workspaceId: true },
      });
      if (document === null) return;
      await this.realtime.emit('agent.page.read', document.workspaceId, correlationId, {
        documentId,
        clientLabel,
      });
    } catch (error) {
      this.logger.warn('Failed to announce an agent read', {
        documentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
