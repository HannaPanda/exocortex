import { type AiProvider } from '@exocortex/ai';
import { QUEUE_NAMES, type Settings } from '@exocortex/contracts';
import {
  digestInputHash,
  type OverviewChild,
  overviewInputHash,
  type PrismaClient,
  readOverviewChildren,
} from '@exocortex/database';
import { type JobContext, type QueueRegistry, type RedisEventBus } from '@exocortex/queue';

import {
  type Composition,
  digestSystemPrompt,
  overviewSystemPrompt,
  parseComposition,
  renderDigestInput,
  renderOverviewInput,
} from './overview/compose';
import { coverPromptFor, type OverviewPage, readOverviewPage } from './overview/page';

/**
 * Keeping one page's derived text current (issue #53, ADR-028).
 *
 * One job is one page and does both halves of its digest row: the summary the
 * overview above it quotes, and, when the page is an overview itself, the
 * paragraph it opens with. Nothing here writes a page body -- an overview is a
 * derived view beside the page, which is the whole point of the ADR.
 *
 * Nothing here throws for a foreseeable outcome either. A model that refuses, a
 * page deleted between the trigger and the run, a deployment whose AI was
 * switched off in the debounce window: all of those end the job quietly or with
 * a recorded error, because a BullMQ retry would pay for the same prompt again
 * and the next change to the page will enqueue another run anyway.
 */

/** Cap on the answer. Two paragraphs, never an essay. */
const MAX_ANSWER_TOKENS = 700;
/** The composition's own timeout. Nobody is waiting, but nothing may hang. */
const COMPOSE_TIMEOUT_MS = 90_000;
/** What a failed composition says on the page. The reason itself is in the log. */
const FAILURE_MESSAGE = 'Der Vorspann konnte nicht erzeugt werden.';
/** How far the cascade may walk up the tree before it gives up. */
const MAX_CASCADE_DEPTH = 8;

export interface DocumentOverviewDependencies {
  prisma: PrismaClient;
  /** The deployment's provider: composing is the deployment's own spend. */
  provider: AiProvider;
  queues: QueueRegistry;
  bus: RedisEventBus;
  settings: (workspaceId?: string) => Promise<Settings>;
  /** Fallback model when no setting names one. */
  defaultModel: string | null;
}

type OverviewStatus = 'ready' | 'unchanged' | 'failed';

export function createDocumentOverviewProcessor(dependencies: DocumentOverviewDependencies) {
  return async ({
    payload,
    logger,
  }: JobContext<typeof QUEUE_NAMES.documentOverview>): Promise<void> => {
    const outcome = await refreshPage({ dependencies, payload, logger });
    if (outcome === null) return;
    await dependencies.bus.publish({
      type: 'document.overview.updated',
      workspaceId: payload.workspaceId,
      correlationId: payload.correlationId,
      emittedAt: new Date().toISOString(),
      payload: { documentId: payload.documentId, status: outcome.status, error: outcome.error },
    });
  };
}

/** What one refresh ended as, or `null` when there was nothing to answer for. */
interface Outcome {
  status: OverviewStatus;
  error: string | null;
}

/**
 * One page's refresh, from the row to the written digest.
 *
 * Returns `null` for the cases where nobody should hear anything: the page is
 * gone, the feature is off, or this page has no derived text at all. Everything
 * else ends in an outcome, including the failures.
 */
async function refreshPage(input: {
  dependencies: DocumentOverviewDependencies;
  payload: JobContext<typeof QUEUE_NAMES.documentOverview>['payload'];
  logger: JobContext<typeof QUEUE_NAMES.documentOverview>['logger'];
}): Promise<Outcome | null> {
  const { dependencies, payload, logger } = input;
  const { prisma } = dependencies;

  const settings = await dependencies.settings(payload.workspaceId);
  const page = await readOverviewPage(
    prisma,
    payload.documentId,
    settings['overview.maxPageChars'],
  );
  if (page === null) return null;
  // Checked again here although the producer checked it: a job sits in a
  // debounce window for minutes, and a workspace that switched overviews off
  // inside that window must not still be charged for one.
  if (!settings['ai.enabled'] || !settings['overview.enabled']) return null;
  // Neither an overview nor under one: nothing about this page is derived,
  // which is the normal state of most pages in a workspace.
  if (!page.isOverview && !page.parentIsOverview) return null;

  const children = page.isOverview ? await readOverviewChildren(prisma, page.id) : [];
  // Before anything is composed: the children that have never been digested.
  // Nothing else would ever ask for them. A page is digested because its parent
  // is an overview, and the day a parent becomes one, no event touches its
  // children -- so without this the first composition would be written from
  // titles alone and would stay that way until somebody edited every child.
  await digestMissingChildren({ dependencies, page, children, settings, payload });

  const plan = planWork({ page, children, force: payload.force });
  if (!plan.needSummary && !plan.needIntro) {
    await offerCover({ dependencies, page, settings, correlationId: payload.correlationId });
    return { status: 'unchanged', error: null };
  }

  const refusal = refuseReason({ page, children, settings });
  if (refusal !== null) {
    // Recorded with the hashes, not without them: a page with two hundred
    // children does not get cheaper by being asked again on every keystroke.
    await writeDigest(prisma, page.id, {
      ...(plan.needSummary ? { summaryInputHash: plan.summaryHash } : {}),
      ...(plan.needIntro ? { introInputHash: plan.introHash } : {}),
      lastError: refusal,
      failedAt: new Date(),
    });
    return { status: 'unchanged', error: refusal };
  }

  return composeAndStore({ dependencies, page, children, plan, settings, payload, logger });
}

/**
 * The paid half: one model call, one row written, and what follows from it.
 *
 * Split from `refreshPage` because everything above it decides *whether* to
 * spend anything and everything here happens once that is settled.
 */
async function composeAndStore(input: {
  dependencies: DocumentOverviewDependencies;
  page: OverviewPage;
  children: readonly OverviewChild[];
  plan: WorkPlan;
  settings: Settings;
  payload: JobContext<typeof QUEUE_NAMES.documentOverview>['payload'];
  logger: JobContext<typeof QUEUE_NAMES.documentOverview>['logger'];
}): Promise<Outcome> {
  const { dependencies, page, children, plan, settings, payload, logger } = input;
  const model = resolveModel(settings, dependencies.defaultModel);

  let composition: Composition;
  try {
    composition = await compose({ dependencies, page, children, model, payload });
  } catch (error) {
    logger.warn('Overview composition failed', {
      documentId: page.id,
      model,
      reason: error instanceof Error ? error.message : String(error),
    });
    // The hashes stay untouched, so the next change to this page tries again.
    // What is already on the page stays: yesterday's overview beats none.
    await writeDigest(dependencies.prisma, page.id, {
      lastError: FAILURE_MESSAGE,
      failedAt: new Date(),
    });
    return { status: 'failed', error: FAILURE_MESSAGE };
  }

  const summary = plan.needSummary ? composition.summary : null;
  const intro = plan.needIntro ? composition.intro : null;
  const now = new Date();
  await writeDigest(dependencies.prisma, page.id, {
    ...(summary === null ? {} : { summary, summaryInputHash: plan.summaryHash, summaryAt: now }),
    ...(intro === null ? {} : { intro, introInputHash: plan.introHash, introAt: now }),
    model: model ?? null,
    lastError: null,
    failedAt: null,
  });
  logger.info('Overview composed', {
    documentId: page.id,
    model,
    wroteSummary: summary !== null,
    wroteIntro: intro !== null,
    children: children.length,
  });

  await offerCover({ dependencies, page, settings, correlationId: payload.correlationId });
  // Only a changed summary reaches the page above: recomposing a parent whose
  // material is identical would be a paid call for the same paragraph.
  if (summary !== null && summary !== page.summary) {
    await cascadeToParent({ dependencies, page, settings, payload });
  }
  return { status: summary === null && intro === null ? 'unchanged' : 'ready', error: null };
}

interface WorkPlan {
  needSummary: boolean;
  needIntro: boolean;
  summaryHash: string;
  introHash: string;
}

/**
 * What this run has to produce.
 *
 * The hash comparison is the whole cost control: an event storm over a page
 * nobody changed the meaning of costs one query per event and no model call at
 * all. An overview page's own summary is hashed over its children rather than
 * over its text, because that is what its summary describes.
 */
function planWork(input: {
  page: OverviewPage;
  children: readonly OverviewChild[];
  force: boolean;
}): WorkPlan {
  const introHash = overviewInputHash({
    title: input.page.title,
    ownText: input.page.ownText,
    children: input.children,
  });
  const summaryHash = input.page.isOverview
    ? introHash
    : digestInputHash({ title: input.page.title, text: input.page.ownText });

  return {
    needSummary:
      input.page.parentIsOverview && (input.force || input.page.summaryInputHash !== summaryHash),
    needIntro: input.page.isOverview && (input.force || input.page.introInputHash !== introHash),
    summaryHash,
    introHash,
  };
}

/** Why this page cannot be composed right now, or `null`. */
function refuseReason(input: {
  page: OverviewPage;
  children: readonly OverviewChild[];
  settings: Settings;
}): string | null {
  if (input.page.isOverview && input.children.length === 0) {
    return 'Diese Übersichtsseite hat noch keine Unterseiten.';
  }
  if (input.page.isOverview && input.children.length > input.settings['overview.maxChildren']) {
    return `Diese Übersichtsseite hat mehr als ${input.settings['overview.maxChildren']} Unterseiten. Die Liste unten bleibt vollständig, ein Vorspann wird nicht erzeugt.`;
  }
  return null;
}

function resolveModel(settings: Settings, fallback: string | null): string | undefined {
  return settings['overview.modelSlug'] ?? settings['ai.defaultModelSlug'] ?? fallback ?? undefined;
}

/**
 * One model call for both halves.
 *
 * An overview page is asked with the overview prompt even when only its summary
 * is missing: that prompt sees the children, and a summary of an overview page
 * written from its own body alone would describe an empty page.
 */
async function compose(input: {
  dependencies: DocumentOverviewDependencies;
  page: OverviewPage;
  children: readonly OverviewChild[];
  model: string | undefined;
  payload: { correlationId: string };
}): Promise<Composition> {
  const material = {
    title: input.page.title,
    path: input.page.parentTitle === null ? [] : [input.page.parentTitle],
    ownText: input.page.ownText,
    children: input.children.map((child) => ({
      title: child.title,
      summary: child.summary,
      isOverview: child.isOverview,
      childCount: child.childCount,
    })),
  };
  const asOverview = input.page.isOverview;

  const result = await input.dependencies.provider.generate({
    messages: [
      { role: 'system', content: asOverview ? overviewSystemPrompt() : digestSystemPrompt() },
      {
        role: 'user',
        content: asOverview ? renderOverviewInput(material) : renderDigestInput(material),
      },
    ],
    model: input.model,
    maxOutputTokens: MAX_ANSWER_TOKENS,
    temperature: 0.2,
    correlationId: input.payload.correlationId,
    timeoutMs: COMPOSE_TIMEOUT_MS,
  });
  return parseComposition(result.text);
}

/** Fields of one digest row this run touches. Everything else is left alone. */
interface DigestWrite {
  summary?: string;
  summaryInputHash?: string;
  summaryAt?: Date;
  intro?: string;
  introInputHash?: string;
  introAt?: Date;
  model?: string | null;
  lastError?: string | null;
  failedAt?: Date | null;
  coverAskedAt?: Date;
}

async function writeDigest(
  prisma: PrismaClient,
  documentId: string,
  write: DigestWrite,
): Promise<void> {
  await prisma.documentDigest.upsert({
    where: { documentId },
    create: { documentId, ...write },
    update: write,
  });
}

/**
 * Asks for a digest for every child that has none yet.
 *
 * Debounced under the child's own job id, so a child that is also being edited
 * is refreshed once. Bounded by `overview.maxChildren`: marking a page as an
 * overview is what starts the spending, and it should cost a known number of
 * small calls rather than an unbounded one.
 *
 * Each finished digest cascades back up and the parent is recomposed once,
 * because the cascade shares this page's debounce window.
 */
async function digestMissingChildren(input: {
  dependencies: DocumentOverviewDependencies;
  page: OverviewPage;
  children: readonly OverviewChild[];
  settings: Settings;
  payload: JobContext<typeof QUEUE_NAMES.documentOverview>['payload'];
}): Promise<void> {
  if (!input.page.isOverview) return;
  const missing = input.children
    .filter((child) => child.summaryInputHash === null)
    .slice(0, input.settings['overview.maxChildren']);
  if (missing.length === 0) return;

  const windowMs = input.settings['overview.debounceSeconds'] * 1_000;
  for (const child of missing) {
    await input.dependencies.queues.enqueueDebounced(
      QUEUE_NAMES.documentOverview,
      {
        correlationId: input.payload.correlationId,
        documentId: child.id,
        workspaceId: input.payload.workspaceId,
        reason: 'child_changed',
        force: false,
        depth: input.payload.depth,
      },
      {
        jobId: `overview-${child.id}`,
        // A short window rather than the full one: these are not reacting to
        // somebody typing, they are the backlog of a page that was just marked,
        // and the overview above them is bare until they arrive.
        delayMs: Math.min(windowMs, 30_000),
        maxDelayMs: windowMs,
      },
    );
  }
}

/**
 * Walks the change one level up.
 *
 * Debounced under the same job id the dispatcher uses, so a parent whose
 * children all changed at once is recomposed once rather than once per child.
 */
async function cascadeToParent(input: {
  dependencies: DocumentOverviewDependencies;
  page: OverviewPage;
  settings: Settings;
  payload: { workspaceId: string; correlationId: string; depth: number };
}): Promise<void> {
  if (input.page.parentId === null || !input.page.parentIsOverview) return;
  if (input.payload.depth >= MAX_CASCADE_DEPTH) return;

  const windowMs = input.settings['overview.debounceSeconds'] * 1_000;
  await input.dependencies.queues.enqueueDebounced(
    QUEUE_NAMES.documentOverview,
    {
      correlationId: input.payload.correlationId,
      documentId: input.page.parentId,
      workspaceId: input.payload.workspaceId,
      reason: 'cascade',
      force: false,
      depth: input.payload.depth + 1,
    },
    {
      jobId: `overview-${input.page.parentId}`,
      delayMs: windowMs,
      maxDelayMs: windowMs * 2,
    },
  );
}

/**
 * Draws a cover for an overview page that has none.
 *
 * Once per page, tracked by `coverAskedAt`: a picture is how a page is
 * recognised in a list, and one that changed whenever a sub-page was renamed
 * would make the page unrecognisable. A cover removed by hand is a decision and
 * stays removed; asking again is a button.
 */
async function offerCover(input: {
  dependencies: DocumentOverviewDependencies;
  page: OverviewPage;
  settings: Settings;
  correlationId: string;
}): Promise<void> {
  const { page, settings } = input;
  if (!page.isOverview || page.hasCover || page.coverAsked) return;
  if (!settings['overview.generateCovers']) return;
  if (!settings['ai.imageGenerationEnabled'] || settings['ai.imageModelSlug'] === null) return;

  const prompt = coverPromptFor(page);
  if (prompt === null) return;

  await input.dependencies.queues.enqueue(
    QUEUE_NAMES.documentCover,
    {
      correlationId: input.correlationId,
      documentId: page.id,
      workspaceId: page.workspaceId,
      // The cover route acts as a human, so the job carries the last person who
      // touched the page. A generated picture passes exactly the checks an
      // uploaded one does (ADR-014), including the one that stops a user who
      // has lost access from installing anything.
      userId: page.updatedById,
      prompt,
    },
    { attempts: 1 },
  );
  // Marked before the picture exists, and deliberately: the offer is what
  // happens once, not the success. A failed generation that re-queued itself on
  // the next refresh would be a paid retry loop nobody asked for.
  await writeDigest(input.dependencies.prisma, page.id, { coverAskedAt: new Date() });
}
