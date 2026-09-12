import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canManageAutomations, WorkspaceAccessService } from '@exocortex/auth';
import {
  type AutomationRun,
  QUEUE_NAMES,
  type TriggerAutomationRuleRequest,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { currentCorrelationId } from '../common/correlation';
import { PRISMA, QUEUES } from '../platform/platform-tokens';
import { SettingsService } from '../platform/settings.service';

import { AUTOMATION_RUN_SELECT, mapAutomationRun } from './automation-mapper';

/**
 * Firing a rule by hand (issue #50, ADR-024).
 *
 * The endpoint that makes an automation debuggable: without it the only way to
 * find out whether a rule works is to edit a page and wait out the debounce. It
 * is also what lets an agent finish what it started -- a rule it can write but
 * not try is half a capability.
 *
 * This is the *only* place in the API that queues an automation. The
 * event-driven path lives in the worker's outbox dispatcher, where the events
 * already arrive, and it deliberately does not create a run row: a debounce
 * window collapses many events into one job, so the run has to be created by
 * whoever runs the job, or a page somebody is typing into fills the log with
 * rows that will never have a result. Here there is no window and a caller
 * waiting for an answer, so the row is created up front and handed back.
 */
@Injectable()
export class AutomationDispatchService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    private readonly access: WorkspaceAccessService,
    private readonly settings: SettingsService,
  ) {}

  async trigger(input: {
    ruleId: string;
    userId: string;
    request: TriggerAutomationRuleRequest;
  }): Promise<AutomationRun> {
    const rule = await this.prisma.automationRule.findUnique({
      where: { id: input.ruleId },
      select: { id: true, workspaceId: true },
    });
    if (rule === null) throw AppError.notFound('The automation rule');

    const role = await this.access.findRole(rule.workspaceId, input.userId);
    assertPolicy(canManageAutomations(role));

    // The workspace switch is honoured even here. "Try it" must not be a way
    // around the emergency stop, or the stop is not one.
    const settings = await this.settings.getForWorkspace(rule.workspaceId);
    if (!settings['automations.enabled']) {
      throw AppError.conflict('Automations are switched off for this workspace');
    }

    const document = await this.access.findDocumentContext(input.request.documentId, input.userId);
    if (document === null || document.workspaceId !== rule.workspaceId) {
      throw new AppError('document_access_denied', 'The page is not accessible');
    }

    const page = await this.prisma.document.findUnique({
      where: { id: input.request.documentId },
      select: { title: true },
    });

    const run = await this.prisma.automationRun.create({
      data: {
        ruleId: rule.id,
        workspaceId: rule.workspaceId,
        documentId: input.request.documentId,
        documentTitle: page?.title ?? null,
        trigger: input.request.trigger,
        status: 'PENDING',
        depth: 0,
      },
      select: AUTOMATION_RUN_SELECT,
    });

    await this.queues.enqueue(QUEUE_NAMES.automation, {
      correlationId: currentCorrelationId(),
      ruleId: rule.id,
      runId: run.id,
      workspaceId: rule.workspaceId,
      documentId: input.request.documentId,
      trigger: input.request.trigger,
      depth: 0,
    });

    return mapAutomationRun(run);
  }
}
