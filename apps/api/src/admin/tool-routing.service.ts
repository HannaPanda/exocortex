import { Inject, Injectable } from '@nestjs/common';

import { JEV_DECISION_MODEL } from '@exocortex/ai';
import { aiRunToolRoutingEventDataSchema, type ToolRoutingStatus } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { ROUTING_THRESHOLD, ROUTING_TIMEOUT_MS } from '@exocortex/mcp-tools';

import { PRISMA } from '../platform/platform-tokens';
import { SettingsService } from '../platform/settings.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The tool routing switch and its last day (issue #206, ADR-089).
 *
 * The switch is the ordinary `ai.semanticToolRouting` setting, written through
 * the ordinary settings service, so the admin form, a workspace override and
 * this route are one value. What this adds is the answer to "is it working":
 * who chose the tools of the runs of the last 24 hours, and why the fallbacks
 * fell back, read from the run timeline.
 */
@Injectable()
export class ToolRoutingService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly settingsService: SettingsService,
  ) {}

  async status(): Promise<ToolRoutingStatus> {
    const settings = await this.settingsService.get();
    const rows = await this.prisma.aiRunEvent.findMany({
      where: { kind: 'tool_routing', at: { gte: new Date(Date.now() - DAY_MS) } },
      select: { data: true },
    });
    const last24h = {
      runs: 0,
      jev: 0,
      keywords: 0,
      fallback: 0,
      fallbackReasons: {} as Record<string, number>,
    };
    for (const row of rows) {
      const parsed = aiRunToolRoutingEventDataSchema.safeParse(row.data);
      if (!parsed.success) continue;
      last24h.runs += 1;
      last24h[parsed.data.decider] += 1;
      if (parsed.data.fallbackReason !== null) {
        const reason = parsed.data.fallbackReason;
        last24h.fallbackReasons[reason] = (last24h.fallbackReasons[reason] ?? 0) + 1;
      }
    }
    return {
      enabled: settings['ai.semanticToolRouting'],
      model: JEV_DECISION_MODEL,
      timeoutMs: ROUTING_TIMEOUT_MS,
      threshold: ROUTING_THRESHOLD,
      last24h,
    };
  }

  async set(enabled: boolean, actorId: string): Promise<ToolRoutingStatus> {
    await this.settingsService.update({ patch: { 'ai.semanticToolRouting': enabled }, actorId });
    return this.status();
  }
}
