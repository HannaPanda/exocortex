import {
  AUTOMATION_ORIGIN_HEADER,
  type QUEUE_NAMES,
  startWorkItemRunResponseSchema,
  workItemResponseSchema,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type JobContext } from '@exocortex/queue';

import { type AutomationRuleRecord } from './run-recorder';

/** A title is a title, not the rule's whole sentence. */
const MAX_TITLE_CHARS = 300;

/**
 * The `WORK_ITEM` action (issue #143, ADR-071): hands the page over as work.
 *
 * The rule's prompt becomes the goal, the page its context, the rule's agent
 * profile the role it runs under. Everything goes through the REST API as
 * the rule's owner, like every other action that writes (ADR-014), and the
 * origin header is what lets the work item route accept the profile: it is
 * the one the owner named when writing this rule. A first run is only
 * started when the rule says so, and only when the AI is switched on.
 */
export async function handOverWork(input: {
  rule: AutomationRuleRecord;
  aiEnabled: boolean;
  prisma: PrismaClient;
  apiClientFor: ((userId: string, headers?: Record<string, string>) => ExocortexApiClient) | null;
  payload: JobContext<typeof QUEUE_NAMES.automation>['payload'];
}): Promise<Record<string, unknown>> {
  const { rule, payload } = input;
  if (rule.prompt === null) throw new Error('The rule has no goal');
  if (input.apiClientFor === null) {
    throw new Error('Automations cannot write: SERVICE_TOKEN_SECRET is not configured');
  }
  if (rule.startWorkItemRun && !input.aiEnabled) {
    throw new Error('AI is switched off for this workspace');
  }
  const owner = rule.createdById;
  if (owner === null) throw new Error('The rule has no owner to act as');
  const client = input.apiClientFor(owner, {
    [AUTOMATION_ORIGIN_HEADER]: `${rule.id}:${String(payload.depth)}`,
  });

  const page = await input.prisma.document.findUnique({
    where: { id: payload.documentId },
    select: { title: true },
  });
  const title = `${rule.name}: ${page?.title ?? 'Unbenannt'}`.slice(0, MAX_TITLE_CHARS);

  const created = await client.request({
    method: 'POST',
    path: `/api/workspaces/${payload.workspaceId}/work-items`,
    body: {
      title,
      goal: rule.prompt,
      contextDocumentIds: page === null ? [] : [payload.documentId],
      ...(rule.agentProfileId === null ? {} : { agentProfileId: rule.agentProfileId }),
    },
    responseSchema: workItemResponseSchema,
  });
  const workItemId = created.workItem.id;
  if (!rule.startWorkItemRun) return { output: 'WORK_ITEM', workItemId };

  const started = await client.request({
    method: 'POST',
    path: `/api/work-items/${workItemId}/runs`,
    body: {},
    responseSchema: startWorkItemRunResponseSchema,
  });
  return { output: 'WORK_ITEM', workItemId, runId: started.run.id };
}
