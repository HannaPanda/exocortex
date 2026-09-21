import { UNTRUSTED_CONTENT_SECTION } from '@exocortex/contracts';
import {
  conversationSourceKindLabel,
  type ConversationSourceRef,
  describeCollection,
  type DocumentType,
  type PrismaClient,
  renderConversationSources,
  type RenderedConversationSource,
  type SearchAdapter,
} from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

export interface BuildSystemPromptInput {
  prisma: PrismaClient;
  workspaceId: string;
  basePrompt: string;
  /** Hard cap on the characters ALWAYS rules may contribute. */
  maxRuleChars: number;
  /** The page the user has open, or `null` when the run has no page context. */
  documentId: string | null;
  /** The open view when `documentId` is a collection. `null` falls back to the first one. */
  databaseViewId: string | null;
  /**
   * The conversation whose pinned sources belong in this prompt (issue #75).
   * `null` for a one-shot run, which has no conversation to pin anything to.
   */
  conversationId: string | null;
  /** `ai.pinnedContextMaxChars`. Zero degrades every pinned source to a pointer. */
  pinnedContextMaxChars: number;
  /** The adapters a pinned saved query is answered with. */
  search: { hybrid: SearchAdapter; keyword: SearchAdapter };
  /** Whether this run may call tools. Decides whether the pointer to the open page is actionable. */
  toolsAvailable: boolean;
  /** `ai.pageContextEnabled`. Off by default; see ADR-015. */
  includePageContent: boolean;
  /** `ai.pageContextMaxChars`. Only consulted when `includePageContent` is set. */
  pageContentMaxChars: number;
  logger: Logger;
}

export interface SystemPromptResult {
  prompt: string;
  alwaysRuleCount: number;
  onDemandRuleCount: number;
  truncated: boolean;
  /** `true` when the prompt names the open page. `false` when there was none, or it was not readable. */
  openPageIncluded: boolean;
  /** Pinned sources that reached the prompt, and what their text cost. */
  pinnedSourceCount: number;
  pinnedSourceChars: number;
}

/** How far up the tree the breadcrumb of the open page is resolved. Deeper ancestors are elided. */
const MAX_PATH_DEPTH = 8;

/**
 * Tells the model exactly what the chat can display, and nothing more
 * (issue #21). This lists precisely the node/mark vocabulary
 * `apps/web/src/components/ai/chat-markdown.tsx` renders (via
 * `pruneForChat` in `packages/editor/src/markdown/chat-render.ts`): naming
 * more here than the surface actually shows would just trade raw asterisks
 * for raw pipes.
 *
 * Deliberately part of the built-in prompt, not of the admin-configured
 * `ai.systemPrompt`: it describes what this build of the product does, not a
 * workspace's own instructions.
 */
const CHAT_FORMATTING_SECTION = [
  '## Antwortformat im Chat',
  'Antworten in diesem Chat werden als Markdown dargestellt, nicht nur als Klartext. ' +
    'Nutzbar sind: Absätze, **fett** und *kursiv*, `Inline-Code`, Codeblöcke mit ' +
    'Sprachangabe (werden farbig hervorgehoben wie im Editor), Aufzählungen und ' +
    'nummerierte Listen, kleine Überschriften, Links (öffnen extern), Zitate mit `>` ' +
    'und Tabellen.',
  'Nicht dargestellt werden Bilder, Kästchen von Aufgabenlisten, Farbmarkierung, ' +
    'Unterstreichung, Spaltenlayout, eingebettete Datenbanken und rohes HTML. Verwende ' +
    'diese hier nicht. Verweise der Form `[[Seite]]` bleiben reiner Text und werden ' +
    'nicht anklickbar.',
].join('\n');

const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  PAGE: 'Seite',
  COLLECTION: 'Sammlung (Datenbank)',
  PROJECT: 'Projekt (Dateibaum, z. B. LaTeX)',
};

export interface OpenPage {
  id: string;
  title: string;
  type: DocumentType;
  archived: boolean;
  /** Ancestor titles from the root down to (and excluding) the page itself. Possibly elided at the front. */
  ancestorTitles: readonly string[];
  /** `true` when the breadcrumb was cut off at `MAX_PATH_DEPTH`. */
  pathElided: boolean;
}

/** Keeps an untitled page from turning into an empty line the model has to guess about. */
function displayTitle(title: string): string {
  return title.trim().length === 0 ? 'Unbenannte Seite' : title;
}

/**
/** The open page's own text, when `ai.pageContextEnabled` put it into the prompt. */
export interface OpenPageContent {
  text: string;
  /** `true` when `ai.pageContextMaxChars` cut it. Always stated in the output. */
  truncated: boolean;
}

export interface OpenPageSectionOptions {
  toolsAvailable: boolean;
  /** Columns, open view and first rows, for a collection. `null` for an ordinary page. */
  collectionDescription?: string | null;
  /** `null` (the default) leaves the block a pointer instead of a copy. */
  content?: OpenPageContent | null;
}

/**
 * Renders the "you are standing here" block.
 *
 * By default this is a pointer, not the content: the model is told which page
 * is open and asked to fetch it with `exo_page_read` when the question is about
 * it. That keeps the page's text out of the prompt of every unrelated turn, and
 * it keeps the fetch under the user's `ai.toolsEnabled` control
 * (docs/adr/ADR-009-provider-neutral-ai.md).
 *
 * `content` overrides that, and only `ai.pageContextEnabled` sets it -- off by
 * default, because it sends the page whether or not the question is about it
 * (docs/adr/ADR-015-page-content-in-the-prompt.md).
 *
 * Exported for tests: everything here is pure formatting.
 */
export function formatOpenPageSection(page: OpenPage, options: OpenPageSectionOptions): string {
  const { toolsAvailable } = options;
  const collectionDescription = options.collectionDescription ?? null;
  const content = options.content ?? null;
  const title = displayTitle(page.title);
  const pathParts = [...page.ancestorTitles.map(displayTitle), title];
  const path = (page.pathElided ? ['…', ...pathParts] : pathParts).join(' / ');

  const lines = [
    '## Geöffnete Seite',
    'Die Nutzerin hat gerade diese Seite offen. Wenn sich eine Frage auf „diese Seite“, „hier“,',
    '„das“ oder auf nichts Genanntes bezieht, ist sie gemeint.',
    '',
    `Titel: ${title}`,
    `Pfad: ${path}`,
    `documentId: ${page.id}`,
    `Typ: ${DOCUMENT_TYPE_LABEL[page.type]}${page.archived ? ' (archiviert)' : ''}`,
    '',
  ];

  // A collection is a shape, not a text: its columns and the open view's
  // filters say more than any amount of prose, and reading the page's body
  // would return nothing useful. So it gets described instead of pointed at.
  if (collectionDescription !== null) {
    lines.push(collectionDescription, '');
    lines.push(
      toolsAvailable
        ? 'Für alles jenseits der gezeigten Zeilen nutze `exo_database_query` mit dieser documentId. Zähle oder rechne nichts aus dem Kopf.'
        : 'Weitere Zeilen kannst du in diesem Lauf nicht laden (Werkzeuge sind aus). Sage das, statt zu schätzen.',
    );
    return lines.join('\n');
  }

  // The text itself, when the admin switched that on. The cut has to be visible
  // in the text: a model that cannot tell an excerpt from a whole page will
  // confidently answer "the page does not mention X" about a page that does.
  if (content !== null) {
    lines.push('### Inhalt', content.text, '');
    if (content.truncated) {
      lines.push(
        toolsAvailable
          ? 'Das ist nur der Anfang der Seite, sie wurde gekürzt. Den Rest holst du mit `exo_page_read`.'
          : 'Das ist nur der Anfang der Seite, sie wurde gekürzt. Mehr kannst du in diesem Lauf nicht laden; sage das, statt den Rest zu erraten.',
      );
    } else {
      lines.push('Das ist der vollständige Text der Seite, Stand der letzten Materialisierung.');
    }
    return lines.join('\n');
  }

  if (toolsAvailable) {
    lines.push(
      'Der Inhalt steht hier nicht. Lade ihn mit `exo_page_read` und dieser documentId,',
      'bevor du über die Seite sprichst, und rate nichts zusammen.',
    );
  } else {
    lines.push(
      'Der Inhalt steht hier nicht, und du kannst ihn in diesem Lauf nicht selbst laden',
      '(Werkzeuge sind aus). Sage das offen, statt den Inhalt zu erraten, und bitte darum,',
      'die betreffende Stelle in die Frage zu kopieren.',
    );
  }

  return lines.join('\n');
}

/**
 * Renders the sources the user pinned to this conversation (issue #75).
 *
 * Two halves, because they cost different things and the model has to tell them
 * apart. An embedded source's text is here and is the whole of what it will
 * ever get about it in this turn, so a cut has to be visible in the text for
 * the same reason it does for the open page: a model that cannot tell an
 * excerpt from a whole page answers "that is not in there" about something that
 * is. A referenced source is a name and an id, which is enough for a
 * tool-capable model and nothing at all for one without tools -- so the block
 * says which of the two this run is.
 *
 * Exported for tests: everything here is pure formatting.
 */
export function formatPinnedSourcesSection(
  sources: readonly RenderedConversationSource[],
  options: { toolsAvailable: boolean },
): string | null {
  if (sources.length === 0) return null;

  const lines = [
    '## Angeheftete Quellen',
    'Diese Quellen hat die Nutzerin dauerhaft an die Unterhaltung geheftet. Sie gelten',
    'unabhängig davon, welche Seite gerade offen ist, und bleiben, bis sie entfernt werden.',
  ];

  const embedded = sources.filter((source) => source.mode === 'EMBED');
  const referenced = sources.filter((source) => source.mode !== 'EMBED');

  for (const source of embedded) {
    lines.push('', `### ${source.title} (${conversationSourceKindLabel(source.kind)})`);
    if (source.subtitle !== null) lines.push(`_${source.subtitle}_`);

    if (source.empty || source.text.length === 0) {
      lines.push(
        options.toolsAvailable
          ? `Hier steht nichts. ${source.pointer}`
          : 'Hier steht nichts, und du kannst es in diesem Lauf nicht selbst laden (Werkzeuge sind aus). Sage das, statt zu raten.',
      );
      continue;
    }

    lines.push(source.text);
    if (source.truncated) {
      lines.push(
        options.toolsAvailable
          ? `Das ist nur der Anfang, die Quelle wurde gekürzt. ${source.pointer}`
          : 'Das ist nur der Anfang, die Quelle wurde gekürzt. Mehr kannst du in diesem Lauf nicht laden; sage das, statt den Rest zu erraten.',
      );
    }
  }

  if (referenced.length > 0) {
    lines.push(
      '',
      options.toolsAvailable
        ? 'Von den folgenden Quellen steht hier nur der Name. Hole sie, wenn eine Frage sie braucht, und rate nichts zusammen:'
        : 'Von den folgenden Quellen steht hier nur der Name, und du kannst sie in diesem Lauf nicht laden (Werkzeuge sind aus). Sage das, statt ihren Inhalt zu erfinden:',
    );
    for (const source of referenced) {
      const where = source.subtitle === null ? '' : `, ${source.subtitle}`;
      lines.push(
        `- ${source.title} (${conversationSourceKindLabel(source.kind)}${where}) — ${source.pointer}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Loads the open page's derived text, cut to the configured budget.
 *
 * Reads the same materialized `markdown` / `plainText` the ALWAYS rule pages
 * read, so there is no second serialization path that could disagree with them
 * (ADR-007: Markdown is derived, never canonical). A page that has never been
 * materialized yields nothing, and the block falls back to being a pointer.
 */
async function loadPageContent(input: {
  prisma: PrismaClient;
  documentId: string;
  maxChars: number;
}): Promise<OpenPageContent | null> {
  const row = await input.prisma.documentContent.findUnique({
    where: { documentId: input.documentId },
    select: { markdown: true, plainText: true },
  });
  const body = row?.markdown ?? row?.plainText ?? null;
  if (body === null || body.trim().length === 0) return null;

  return body.length > input.maxChars
    ? { text: body.slice(0, input.maxChars), truncated: true }
    : { text: body, truncated: false };
}

/**
 * Loads the conversation's pinned sources and renders them as one section.
 *
 * `null` when nothing is pinned, so the caller pushes nothing rather than an
 * empty heading.
 */
async function loadPinnedSourcesSection(input: {
  prisma: PrismaClient;
  workspaceId: string;
  conversationId: string;
  maxChars: number;
  search: { hybrid: SearchAdapter; keyword: SearchAdapter };
  toolsAvailable: boolean;
  logger: Logger;
}): Promise<{ section: string; count: number; chars: number } | null> {
  const rows = await input.prisma.aiConversationSource.findMany({
    where: { conversationId: input.conversationId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      kind: true,
      mode: true,
      documentId: true,
      databaseViewId: true,
      savedQueryId: true,
    },
  });
  if (rows.length === 0) return null;

  const refs: ConversationSourceRef[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    mode: row.mode,
    documentId: row.documentId,
    databaseViewId: row.databaseViewId,
    savedQueryId: row.savedQueryId,
  }));
  const rendered = await renderConversationSources({
    prisma: input.prisma,
    workspaceId: input.workspaceId,
    sources: refs,
    maxChars: input.maxChars,
    search: input.search,
    logger: input.logger,
  });

  const section = formatPinnedSourcesSection(rendered.sources, {
    toolsAvailable: input.toolsAvailable,
  });
  if (section === null) return null;
  return { section, count: rendered.sources.length, chars: rendered.budget.usedChars };
}

/**
 * Loads the open page and its breadcrumb.
 *
 * Scoped to the run's workspace on purpose: a run may carry a `documentId` from
 * an older turn or from a client that guessed one, and a title from a workspace
 * the run has nothing to do with must never reach the prompt.
 */
async function loadOpenPage(input: {
  prisma: PrismaClient;
  workspaceId: string;
  documentId: string;
}): Promise<OpenPage | null> {
  const { prisma, workspaceId, documentId } = input;

  const document = await prisma.document.findFirst({
    where: { id: documentId, workspaceId },
    select: { id: true, title: true, type: true, parentId: true, archivedAt: true },
  });
  if (document === null) return null;

  const ancestorTitles: string[] = [];
  let parentId = document.parentId;
  let pathElided = false;
  for (let depth = 0; parentId !== null; depth += 1) {
    if (depth >= MAX_PATH_DEPTH) {
      pathElided = true;
      break;
    }
    const parent: { title: string; parentId: string | null } | null =
      await prisma.document.findFirst({
        where: { id: parentId, workspaceId },
        select: { title: true, parentId: true },
      });
    if (parent === null) break;
    ancestorTitles.unshift(parent.title);
    parentId = parent.parentId;
  }

  return {
    id: document.id,
    title: document.title,
    type: document.type,
    archived: document.archivedAt !== null,
    ancestorTitles,
    pathElided,
  };
}

/** One ALWAYS rule page, as the query above selects it. */
interface AlwaysRuleRow {
  id: string;
  title: string;
  content: { markdown: string | null; plainText: string | null } | null;
}

/**
 * The workspace's ALWAYS rule pages, in priority order and inside one budget.
 *
 * The budget is spent in order and the section says out loud when it ran out:
 * a rule page silently missing from the prompt is a rule nobody can tell was
 * not applied.
 */
function buildAlwaysRulesSection(input: {
  rules: readonly AlwaysRuleRow[];
  maxRuleChars: number;
  workspaceId: string;
  logger: Logger;
}): { section: string | null; count: number; truncated: boolean } {
  const { rules, maxRuleChars, workspaceId, logger } = input;
  if (rules.length === 0) return { section: null, count: 0, truncated: false };

  const parts: string[] = ['## Regeln aus dem Arbeitsbereich'];
  let remainingBudget = maxRuleChars;
  let count = 0;
  let truncated = false;

  for (const rule of rules) {
    const body = rule.content?.markdown ?? rule.content?.plainText ?? null;
    if (body === null || body.trim().length === 0) {
      logger.info('Skipping an ALWAYS rule page that has never been materialized', {
        documentId: rule.id,
        workspaceId,
      });
      continue;
    }
    if (body.length > remainingBudget) {
      truncated = true;
      break;
    }
    remainingBudget -= body.length;
    parts.push(`### ${rule.title}\n${body}`);
    count += 1;
  }

  if (truncated) parts.push('_Weitere Regelseiten wurden wegen ihrer Länge nicht eingefügt._');
  return {
    section: count > 0 || truncated ? parts.join('\n\n') : null,
    count,
    truncated,
  };
}

/**
 * Builds the system prompt for a run: the admin-configured base prompt, then the
 * built-in chat formatting section, then the workspace's ALWAYS rule pages in
 * priority order, then a catalogue of ON_DEMAND rules with their triggers only.
 *
 * ON_DEMAND rules are the reason the context stays small: the model sees one line
 * per rule and calls `exo_rules_load` for the body when the trigger matches.
 *
 * The open page is named last, right before the workspace and date line, because
 * it is situational: workspace rules say how to behave, the page says where the
 * user is standing.
 */
export async function buildSystemPrompt(
  input: BuildSystemPromptInput,
): Promise<SystemPromptResult> {
  const {
    prisma,
    workspaceId,
    basePrompt,
    maxRuleChars,
    documentId,
    databaseViewId,
    conversationId,
    pinnedContextMaxChars,
    search,
    toolsAvailable,
    includePageContent,
    pageContentMaxChars,
    logger,
  } = input;

  const [alwaysRules, onDemandRules] = await Promise.all([
    prisma.document.findMany({
      where: { workspaceId, archivedAt: null, aiRuleMode: 'ALWAYS' },
      orderBy: [{ aiRulePriority: 'asc' }, { title: 'asc' }],
      select: { id: true, title: true, content: { select: { markdown: true, plainText: true } } },
    }),
    prisma.document.findMany({
      where: { workspaceId, archivedAt: null, aiRuleMode: 'ON_DEMAND' },
      orderBy: [{ aiRulePriority: 'asc' }, { title: 'asc' }],
      select: { id: true, aiRuleTrigger: true },
    }),
  ]);

  // The trust boundary is described before anything a page or a document can
  // say, so the rule is in the context ahead of the text it is a rule about
  // (issue #56, ADR-030).
  const sections: string[] = [basePrompt, CHAT_FORMATTING_SECTION, UNTRUSTED_CONTENT_SECTION];
  const always = buildAlwaysRulesSection({ rules: alwaysRules, maxRuleChars, workspaceId, logger });
  if (always.section !== null) sections.push(always.section);
  const { truncated, count: alwaysRuleCount } = always;

  let onDemandRuleCount = 0;
  const onDemandLines = onDemandRules
    .filter((rule) => rule.aiRuleTrigger !== null && rule.aiRuleTrigger.trim().length > 0)
    // The identifier in a code span: it is 24 random characters the model
    // copies by hand into `exo_rules_load`, and a run on 2026-09-21 spent a
    // call on one that had lost its last character.
    .map((rule) => `- ${rule.aiRuleTrigger} (documentId: \`${rule.id}\`)`);
  if (onDemandLines.length > 0) {
    onDemandRuleCount = onDemandLines.length;
    sections.push(
      [
        '## Regeln auf Anfrage',
        'Wenn eine der folgenden Situationen zutrifft, lade die ausführlichen Anweisungen',
        'mit dem Werkzeug `exo_rules_load` und der genannten documentId, bevor du handelst:',
        ...onDemandLines,
      ].join('\n'),
    );
  }

  let openPageIncluded = false;
  if (documentId !== null) {
    const openPage = await loadOpenPage({ prisma, workspaceId, documentId });
    if (openPage === null) {
      logger.info(
        'Run carries a documentId that is not in its workspace; omitting the page context',
        {
          documentId,
          workspaceId,
        },
      );
    } else {
      // A collection's own body is empty by construction (its rows are separate
      // documents), so the content switch does not apply to one: the view
      // description above is already the richer answer.
      const content =
        includePageContent && openPage.type === 'PAGE'
          ? await loadPageContent({
              prisma,
              documentId: openPage.id,
              maxChars: pageContentMaxChars,
            })
          : null;

      const collectionDescription =
        openPage.type === 'COLLECTION'
          ? await describeCollection({
              prisma,
              workspaceId,
              documentId: openPage.id,
              viewId: databaseViewId,
              logger,
            }).catch((error: unknown) => {
              logger.info('Skipping the collection description for this run', {
                documentId: openPage.id,
                workspaceId,
                reason: error instanceof Error ? error.message : String(error),
              });
              return null;
            })
          : null;
      sections.push(
        formatOpenPageSection(openPage, { toolsAvailable, collectionDescription, content }),
      );
      openPageIncluded = true;
    }
  }

  // After the open page, before the closing line: the page says where the user
  // is standing, the pinned sources say what they carry with them wherever they
  // stand. Both are situational, and both belong below the workspace's rules.
  const pinned =
    conversationId === null
      ? null
      : await loadPinnedSourcesSection({
          prisma,
          workspaceId,
          conversationId,
          maxChars: pinnedContextMaxChars,
          search,
          toolsAvailable,
          logger,
        });
  if (pinned !== null) sections.push(pinned.section);
  const pinnedSourceCount = pinned?.count ?? 0;
  const pinnedSourceChars = pinned?.chars ?? 0;

  const today = new Date().toISOString().slice(0, 10);
  sections.push(`Aktueller Arbeitsbereich: ${workspaceId}. Heutiges Datum: ${today}.`);

  return {
    prompt: sections.join('\n\n'),
    alwaysRuleCount,
    onDemandRuleCount,
    truncated,
    openPageIncluded,
    pinnedSourceCount,
    pinnedSourceChars,
  };
}
