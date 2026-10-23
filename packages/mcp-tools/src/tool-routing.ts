/**
 * How a semantic decision engine is asked which tool domains a task needs
 * (issue #206, ADR-089).
 *
 * The words of the question are part of the measurement: Jev was evaluated in
 * phase 0 against exactly these descriptions, this product sentence and this
 * state shape (`scripts/tool-routing-eval.mjs`, which imports them from here),
 * and a reworded question is an unmeasured router. Change them only together
 * with a new measurement on the gold standard.
 *
 * English, because the engine's instructions are, and written as the
 * capability a request needs rather than as the words it might use: the whole
 * point is that the words may be in any language.
 *
 * Pure data and pure functions. The call itself is the worker's, because only
 * the worker holds a decision provider; this package reaches no model.
 */

import { ALWAYS_OFFERED_DOMAINS } from './domains.js';
import { TOOL_DOMAINS, type ToolDomain } from './tool.js';

/** What each routed domain is, for a decision engine. */
export const ROUTING_QUESTIONS = {
  history:
    'see earlier versions of a page, compare versions, see who changed what and when, or restore an earlier state or deleted content',
  lifecycle: 'archive a page, move it to the trash, or delete it permanently',
  appearance:
    'change how a page looks or behaves: its cover image, its width or layout, a standing AI instruction for the page, or an overview of its subpages',
  inbox: 'quickly capture a note or thought into the inbox to be sorted later, or clip a web page',
  comments: 'read, write, edit or resolve comments or remarks attached to a page or a paragraph',
  databases:
    'work with a structured database (table, collection): its columns, rows or entries, views, filters, sorting or counting entries',
  attachments:
    'look at a picture, photo, screenshot, scan or drawing, read or correct the text of an attached file such as a PDF, upload a file, or download one',
  templates: 'create, change or use a page template, a reusable structure for new pages',
  savedQueries:
    'save a search, or create a smart view or saved filter that keeps showing matching pages',
  workItems:
    'hand a piece of work over to the AI as a tracked assignment (with a goal, a deadline or a status to check later), check how such an assignment is progressing, or manage agent profiles',
  attention:
    'see or answer what is waiting for a human: open questions from agents, pending decisions or approvals',
  changesets:
    'prepare changes as a proposal the user reviews and accepts before anything is written, or look at, accept or reject such proposals',
  evals: 'run, compare or review saved test cases that measure AI models or agents',
  workflows:
    'build, change, run or inspect a multi-step agent workflow with triggers, agent steps, conditions and human approvals',
  shares: 'share a page with someone, create a public link, or see who has access to a page',
  entities:
    'look up or link people, companies or organisations as entities and the pages about them',
  memory:
    "store a fact in the assistant's long-term memory because the user explicitly asks for it to be remembered in future sessions, look up what was remembered in earlier sessions, or use the mailbox between agents",
  chats: 'search or read earlier AI conversations, inspect AI runs, or see how much the AI cost',
  automations:
    'set up something that happens automatically: on a schedule, when something changes, or as a recurring reminder',
  notifications:
    "change the user's own settings: interface language, notifications, push to a device, email preferences",
  projects: 'work on a LaTeX project: its source files, bibliography, compiling it and its errors',
  render: 'turn a page into a PDF or a print-ready document, or manage render templates',
  web: 'search the internet or read a web page, for anything the workspace itself cannot know such as current prices, news or results',
  admin: 'invite people, manage user accounts (lock, delete), or rename the workspace',
} as const satisfies Partial<Record<ToolDomain, string>>;

/** The domains a decision engine is asked about: everything but `core`, `pages` and `external`. */
export type RoutedDomain = keyof typeof ROUTING_QUESTIONS;
export const ROUTED_DOMAINS = Object.keys(ROUTING_QUESTIONS) as RoutedDomain[];

/** What the engine is told this product is, so "page" never means a web page. */
export const ROUTING_PRODUCT =
  'eXocortex is a personal workspace of nested pages (notes). "Page" always means a page in this workspace, never a web page. The assistant can always read, search, write, rename and move pages; the question is which additional tools it needs.';

/**
 * The probability from which a domain is offered. Chosen on the dev split of
 * the gold standard and confirmed once on the holdout (98.1 % of cases got
 * every domain they needed), so it is a measured number, not a default.
 */
export const ROUTING_THRESHOLD = 0.5;

/**
 * How long a run waits for the engine before it starts with the keywords.
 * Measured p95 was 300 to 906 ms; a run is never held longer than this for a
 * choice the keywords can also make.
 */
export const ROUTING_TIMEOUT_MS = 1_500;

/** What a run knows about the open page without asking anything. */
export interface RoutingContext {
  databaseViewOpen?: boolean;
  pageAttachments?: readonly ('image' | 'pdf')[];
}

/** One yes/no question per routed domain, keyed by the domain. */
export function routingQuestions(): Record<RoutedDomain, { kind: 'yesNo'; instructions: string }> {
  return Object.fromEntries(
    ROUTED_DOMAINS.map((domain) => [
      domain,
      {
        kind: 'yesNo',
        instructions: `Does fulfilling the \`request\` require tools to ${ROUTING_QUESTIONS[domain]}?`,
      },
    ]),
  ) as Record<RoutedDomain, { kind: 'yesNo'; instructions: string }>;
}

/** What is judged: the product, the person's words and what the page is known to carry. */
export function routingState(text: string, context: RoutingContext = {}): Record<string, unknown> {
  const known: Record<string, unknown> = {};
  if (context.databaseViewOpen === true) known.openPage = 'a database view';
  if ((context.pageAttachments ?? []).length > 0) {
    known.pageCarries = (context.pageAttachments ?? []).map((kind) =>
      kind === 'image' ? 'pictures' : 'PDF files',
    );
  }
  return {
    product: ROUTING_PRODUCT,
    request: text,
    ...(Object.keys(known).length > 0 ? { context: known } : {}),
  };
}

/**
 * The domains one run is offered from the engine's answers: the ones every run
 * has, the ones the caller already knows are needed, and every routed domain
 * at or above the threshold. In `TOOL_DOMAINS` order, like the keyword
 * selection, so two runs of the same answer produce the same list.
 */
export function domainsFromProbabilities(
  probabilities: Readonly<Partial<Record<string, number>>>,
  required: readonly ToolDomain[] = [],
  threshold: number = ROUTING_THRESHOLD,
): ToolDomain[] {
  const chosen = new Set<ToolDomain>([...ALWAYS_OFFERED_DOMAINS, ...required]);
  for (const domain of ROUTED_DOMAINS) {
    const probability = probabilities[domain];
    if (probability !== undefined && probability >= threshold) chosen.add(domain);
  }
  return TOOL_DOMAINS.filter((domain) => chosen.has(domain));
}
