import {
  AUTOMATION_MAX_DEPTH,
  type AutomationTrigger,
  QUEUE_NAMES as QUEUES,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { type QueueRegistry } from '@exocortex/queue';

/**
 * Turning a domain event into an automation firing (issue #50, ADR-024).
 *
 * This sits inside the outbox dispatcher rather than beside it, because the
 * outbox is already the one place every domain event passes exactly once, in
 * order, with at-least-once delivery. A second listener would be a second thing
 * to keep correct, and the first time Redis blinked the two would disagree
 * about what happened.
 *
 * Nothing here acts. It decides *whether* a rule should run and hands the job to
 * the `automation` queue; the acting, the run row and the failure counting all
 * happen in `apps/worker/src/processors/automation.ts`.
 */

/**
 * Which trigger a domain event is, or `null` when it is not one.
 *
 * The mapping is deliberately narrow. Job progress, AI runs, comments and cover
 * generation all travel the same channel, and a rule that fired on those would
 * be reacting to the system's own bookkeeping rather than to a page changing.
 */
export function triggerForEvent(eventType: string): AutomationTrigger | null {
  switch (eventType) {
    case 'document.created':
      return 'DOCUMENT_CREATED';
    case 'document.updated':
      return 'DOCUMENT_UPDATED';
    // Both mean "the text is different now": one is the editor's own
    // materialization, the other a write that came from outside it (ADR-016).
    case 'document.materialized':
    case 'document.content.replaced':
      return 'DOCUMENT_CONTENT_CHANGED';
    case 'document.moved':
      return 'DOCUMENT_MOVED';
    case 'document.archived':
      return 'DOCUMENT_ARCHIVED';
    case 'document.deleted':
      return 'DOCUMENT_DELETED';
    case 'database.row.updated':
      return 'DATABASE_ROW_CHANGED';
    default:
      return null;
  }
}

/** Depth at which the ancestor walk gives up. A page tree is not this deep. */
const MAX_ANCESTOR_DEPTH = 64;

export interface AutomationEvent {
  workspaceId: string;
  type: string;
  payload: unknown;
  correlationId: string;
  /** The rule whose action caused this write, when one did. */
  automationRuleId: string | null;
  automationDepth: number;
}

export interface AutomationMatchContext {
  prisma: PrismaClient;
  queues: QueueRegistry;
  logger: Logger;
  /** Whether automations run in this workspace at all (`automations.enabled`). */
  enabledFor: (workspaceId: string) => Promise<boolean>;
}

/**
 * Queues every rule this event should fire.
 *
 * Cheap when nothing matches, which is the normal case: one indexed query for
 * the workspace's enabled rules, and the settings lookup in front of it is
 * cached. A deployment with no rules pays for the settings read alone.
 */
export async function fireMatchingAutomations(
  context: AutomationMatchContext,
  event: AutomationEvent,
): Promise<number> {
  const trigger = triggerForEvent(event.type);
  if (trigger === null) return 0;

  const documentId = subjectDocumentId(event);
  if (documentId === null) return 0;

  if (!(await context.enabledFor(event.workspaceId))) return 0;

  const rules = await context.prisma.automationRule.findMany({
    where: { workspaceId: event.workspaceId, enabled: true, triggers: { has: trigger } },
    select: { id: true, scope: true, scopeDocumentId: true, debounceSeconds: true },
  });
  if (rules.length === 0) return 0;

  const scoped = rules.filter((rule) => rule.scope !== 'WORKSPACE');
  const ancestry =
    scoped.length === 0
      ? new Set<string>()
      : await ancestorIds(context.prisma, documentId, event.workspaceId);

  const depth = event.automationDepth + 1;
  let fired = 0;
  for (const rule of rules) {
    // A rule never reacts to its own action. This is the first and cheapest of
    // the two loop guards, and the one that matters in practice: the shape
    // people actually build is "when this page changes, write something on it",
    // and without this it would rewrite the page it just wrote, for ever.
    if (rule.id === event.automationRuleId) continue;
    if (!inScope(rule, documentId, ancestry)) continue;

    // The second guard, for chains that go through *other* rules. Past the
    // limit the firing is dropped here rather than queued and refused later:
    // the run log gets no row for it, and the log line below is the record.
    if (depth > AUTOMATION_MAX_DEPTH) {
      context.logger.warn('Automation chain stopped at the depth limit', {
        ruleId: rule.id,
        documentId,
        depth,
        correlationId: event.correlationId,
      });
      continue;
    }

    const windowMs = rule.debounceSeconds * 1_000;
    await context.queues.enqueueDebounced(
      QUEUES.automation,
      {
        correlationId: event.correlationId,
        ruleId: rule.id,
        runId: null,
        workspaceId: event.workspaceId,
        documentId,
        trigger,
        depth,
      },
      {
        // BullMQ forbids ":" in a custom job id. The pair is what the window is
        // per: two pages under one rule debounce independently, because they
        // are two different changes.
        jobId: `automation-${rule.id}-${documentId}`,
        delayMs: windowMs,
        // Twice the window, so a page somebody keeps typing into still gets its
        // rule run instead of being postponed all afternoon.
        maxDelayMs: windowMs * 2,
      },
    );
    fired += 1;
  }
  return fired;
}

/**
 * The page this event is about.
 *
 * For a row change that is `rowId`, not `documentId`: the payload's
 * `documentId` is the collection, because that is what a client invalidates,
 * and a rule scoped to a database has to act on the row that changed.
 */
function subjectDocumentId(event: AutomationEvent): string | null {
  if (typeof event.payload !== 'object' || event.payload === null) return null;
  const payload = event.payload as Record<string, unknown>;
  const rowId = payload.rowId;
  if (typeof rowId === 'string') return rowId;
  const documentId = payload.documentId;
  return typeof documentId === 'string' ? documentId : null;
}

/**
 * Whether a rule's scope contains the page.
 *
 * `SUBTREE` includes the root itself, because a rule on "Technik" that ignored
 * changes to the Technik page would be a surprise. `DATABASE` is the same test:
 * a row is a child of its COLLECTION (ADR-011), so "under it" is what being a
 * row means.
 */
function inScope(
  rule: { scope: string; scopeDocumentId: string | null },
  documentId: string,
  ancestry: ReadonlySet<string>,
): boolean {
  if (rule.scope === 'WORKSPACE') return true;
  if (rule.scopeDocumentId === null) return false;
  return documentId === rule.scopeDocumentId || ancestry.has(rule.scopeDocumentId);
}

/**
 * The ids of every page above this one, walked one parent at a time.
 *
 * One small indexed query per level rather than loading the workspace's tree:
 * the dispatcher runs every five seconds, and a page eight levels deep costs
 * eight key lookups here against thousands of rows there. Walked once per
 * event and reused for every rule, so a workspace with twenty scoped rules
 * still pays for one walk.
 *
 * `workspaceId` bounds it: a parent chain must never leave the workspace the
 * event belongs to, and if it somehow did, a rule there must not see it.
 */
async function ancestorIds(
  prisma: PrismaClient,
  documentId: string,
  workspaceId: string,
): Promise<Set<string>> {
  const ancestors = new Set<string>();
  let current: string | null = documentId;
  for (let level = 0; level < MAX_ANCESTOR_DEPTH && current !== null; level += 1) {
    const row: { parentId: string | null } | null = await prisma.document.findFirst({
      where: { id: current, workspaceId },
      select: { parentId: true },
    });
    current = row?.parentId ?? null;
    // A cycle would otherwise spin until the depth limit; corrupt data must
    // cost one wasted walk, not a stuck dispatcher.
    if (current !== null && ancestors.has(current)) break;
    if (current !== null) ancestors.add(current);
  }
  return ancestors;
}
