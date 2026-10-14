/**
 * The gold standard of #206 and the domain descriptions every router under
 * test is given, shared by `scripts/tool-routing-eval.mjs` and the local
 * challengers in `evals/tool-routing/local/`, so no two routers are measured
 * against different words.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOLD = join(dirname(fileURLToPath(import.meta.url)), '../../evals/tool-routing/gold.json');

/**
 * What each optional domain is, for a decision engine.
 *
 * English, because the engine's instructions are, and written as the
 * capability a request needs rather than as the words it might use: the
 * whole point is that the words may be in any language. Kept beside the
 * scripts rather than in `packages/mcp-tools`, because nothing in the product
 * reads them until phase 0 says it should.
 */
export const DOMAIN_QUESTIONS = {
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
};

/** Never routed: offered from the workspace's approvals or not at all (ADR-086). */
export const UNROUTED = new Set(['core', 'pages', 'external']);
export const OPTIONAL_DOMAINS = Object.keys(DOMAIN_QUESTIONS);

export const PRODUCT =
  'eXocortex is a personal workspace of nested pages (notes). "Page" always means a page in this workspace, never a web page. The assistant can always read, search, write, rename and move pages; the question is which additional tools it needs.';

/** One entry per sentence: a group's meaning, in one language. */
export function loadCases(split) {
  const gold = JSON.parse(readFileSync(GOLD, 'utf8'));
  for (const group of gold.groups) {
    for (const domain of [...group.expected, ...(group.acceptable ?? [])]) {
      if (!OPTIONAL_DOMAINS.includes(domain)) {
        throw new Error(`${group.id} names ${domain}, which is not a routed domain`);
      }
    }
  }
  const cases = [];
  for (const group of gold.groups) {
    if (split !== 'all' && group.split !== split) continue;
    for (const [language, text] of Object.entries(group.texts)) {
      const texts = Array.isArray(text) ? text : [text];
      texts.forEach((entry, index) =>
        cases.push({
          id: `${group.id}/${language}${texts.length > 1 ? `#${index}` : ''}`,
          group: group.id,
          kind: group.kind,
          language,
          text: entry,
          context: group.context ?? {},
          expected: group.expected,
          acceptable: group.acceptable ?? [],
        }),
      );
    }
  }
  return cases;
}
