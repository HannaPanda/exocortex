import {
  AUTOMATION_MAX_MAIL_CHARS,
  AUTOMATION_ORIGIN_HEADER,
  markdownExportResponseSchema,
  QUEUE_NAMES,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type QueueRegistry } from '@exocortex/queue';

/**
 * The mail action: a page, to the person who wrote the rule (issue #104,
 * ADR-054).
 *
 * Three decisions are made here and nowhere else, and each of them is the
 * reason the action is called `EMAIL_SELF` rather than `EMAIL`:
 *
 *   - **Who.** The account on `createdById`, read now rather than when the
 *     rule was written, and only while it exists, is switched on and has a
 *     verified address. There is no recipient field anywhere on a rule, so
 *     there is nothing for a person or a model to point at an inbox.
 *   - **What.** The page is fetched through the API *as its owner*, so a rule
 *     cannot mail out a page its owner may not read. That is the same client
 *     the AI action uses, for the same reason.
 *   - **How much.** `AUTOMATION_MAX_MAIL_CHARS`, cut on a line boundary, with
 *     the mail saying that it was cut. A mail is a copy that cannot be
 *     corrected once it has left.
 *
 * It queues rather than sends. A relay having a bad five minutes would
 * otherwise fail a run, and five failed runs switch a rule off
 * (`automations.maxConsecutiveFailures`) -- so an outage at the relay would
 * end with somebody's daily agenda quietly disabled.
 */

/** What this action needs, which is rather less than a webhook or an AI run. */
export interface MailActionInput {
  dependencies: {
    prisma: PrismaClient;
    apiClientFor:
      ((userId: string, headers?: Readonly<Record<string, string>>) => ExocortexApiClient) | null;
    queues: QueueRegistry;
    appUrl: string;
  };
  rule: { id: string; name: string; mailSubject: string | null; createdById: string | null };
  payload: {
    correlationId: string;
    workspaceId: string;
    documentId: string;
    depth: number;
  };
}

/** `mailTitleSchema`'s limit; the producer shortens rather than being refused. */
const MAX_TITLE_LENGTH = 200;
/** A page with no title still has to be nameable in a subject line. */
const UNTITLED = 'Unbenannte Seite';

export async function sendPageToOwner(
  input: MailActionInput,
  runId: string,
): Promise<Record<string, unknown>> {
  const { dependencies, rule, payload } = input;
  const owner = rule.createdById;
  if (owner === null) throw new Error('The rule has no owner to act as');
  if (dependencies.apiClientFor === null) {
    throw new Error('Automations cannot read a page: SERVICE_TOKEN_SECRET is not configured');
  }

  const recipient = await recipientFor(dependencies.prisma, owner);

  // Read as the owner, with the rule stamped on the request. The stamp changes
  // nothing about a read -- it is loop protection for writes -- but a request
  // an automation made should say so wherever it is logged.
  const client = dependencies.apiClientFor(owner, {
    [AUTOMATION_ORIGIN_HEADER]: `${rule.id}:${String(payload.depth)}`,
  });
  const page = await client.request({
    method: 'GET',
    path: `/api/documents/${payload.documentId}/export/markdown`,
    responseSchema: markdownExportResponseSchema,
  });

  const titleRow = await dependencies.prisma.document.findUnique({
    where: { id: payload.documentId },
    select: { title: true },
  });
  const documentTitle = titleOf(titleRow?.title ?? '');
  const { body, truncated } = cut(page.markdown);
  const base = dependencies.appUrl.replace(/\/$/, '');

  await dependencies.queues.enqueue(
    QUEUE_NAMES.mail,
    {
      correlationId: payload.correlationId,
      recipient: recipient.email,
      mail: {
        template: 'AUTOMATION_PAGE',
        ruleName: titleOf(rule.name),
        subject: titleOf(rule.mailSubject ?? rule.name),
        documentTitle,
        url: `${base}/arbeitsbereich/${payload.workspaceId}/seite/${payload.documentId}`,
        body,
        truncated,
      },
    },
    // One run, one letter. A job whose worker died after enqueueing is retried
    // by BullMQ and reaches this line again; the id keeps that from being a
    // second copy of the same morning's page.
    { jobId: `automation-mail-${runId}` },
  );

  // "queued", and deliberately not "sent" or "delivered": what the relay said
  // is written by the mail job, and what the inbox did nobody here can know
  // (ADR-051). The domain is enough to tell two accounts apart in a log
  // without putting an address in one.
  return { action: 'EMAIL_SELF', queued: true, recipientDomain: recipient.domain };
}

/**
 * The owner's address, or a refusal naming the reason.
 *
 * A refusal is a failed run rather than a skipped one on purpose: a rule that
 * cannot reach its owner is broken and should end up switched off with the
 * reason on it, not quietly do nothing every morning.
 */
async function recipientFor(
  prisma: PrismaClient,
  userId: string,
): Promise<{ email: string; domain: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true, disabledAt: true },
  });
  if (user === null) throw new Error('The rule has no owner to act as');
  // Switching an account off withdraws its credentials (issue #3). A mail
  // would be the one thing about it that still worked.
  if (user.disabledAt !== null) throw new Error('The rule’s owner is switched off');
  // The whole guarantee rests on the address belonging to the account. An
  // unverified one is a string somebody typed, and this action would post a
  // page to it every morning.
  if (!user.emailVerified) {
    throw new Error('The rule’s owner has no confirmed e-mail address');
  }
  return { email: user.email, domain: user.email.split('@').pop() ?? '' };
}

/**
 * The page as much of it as a mail carries.
 *
 * Cut on a line boundary when there is one nearby, because a Markdown table or
 * a list chopped mid-row reads as damage rather than as an excerpt.
 */
function cut(markdown: string): { body: string; truncated: boolean } {
  if (markdown.length <= AUTOMATION_MAX_MAIL_CHARS) {
    return { body: markdown, truncated: false };
  }
  const head = markdown.slice(0, AUTOMATION_MAX_MAIL_CHARS);
  const lastBreak = head.lastIndexOf('\n');
  const keep = lastBreak > AUTOMATION_MAX_MAIL_CHARS - 500 ? head.slice(0, lastBreak) : head;
  return { body: keep, truncated: true };
}

/** A name, bounded and never empty, as `mailTitleSchema` insists. */
function titleOf(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return UNTITLED;
  return flat.length <= MAX_TITLE_LENGTH ? flat : `${flat.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}
