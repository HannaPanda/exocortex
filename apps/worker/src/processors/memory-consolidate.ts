import { type AiProvider } from '@exocortex/ai';
import {
  memoryConsolidateResponseSchema,
  memoryFactListResponseSchema,
  type MemoryFactVerdict,
  type QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type JobContext } from '@exocortex/queue';

/**
 * What the judge is asked for.
 *
 * The whole mechanism turns on one instruction: a note that repeats something
 * the memory already holds must come back as `BESTAETIGT`, not as `NEU`. Get
 * that wrong and consolidation is just a second, more expensive way of writing
 * the same thing down again.
 *
 * The second load-bearing line is the permission to answer `NICHTS`. Most
 * session notes are about work, not about the world, and a memory that turns
 * every "renamed a variable" into a standing fact is worse than no memory.
 */
const JUDGE_PROMPT = [
  'Du pflegst das Faktenwissen eines Agenten über ein Projekt.',
  'Du bekommst bekannte Fakten mit ihrer Id und neue Sitzungsnotizen mit ihrer Id.',
  'Eine Notiz erzählt, was jemand getan hat. Du destillierst daraus, was seitdem gilt.',
  '',
  'Antworte ausschließlich mit Zeilen in diesem Format, eine Zeile je Aussage:',
  'NEU | <notizId> | - | <eine Aussage>',
  'BESTAETIGT | <notizId> | <faktId> | -',
  'ERSETZT | <notizId> | <faktId> | <neue Aussage>',
  'WIDERSPRUCH | <notizId> | <faktId> | -',
  'NICHTS | <notizId> | - | -',
  '',
  'So sieht eine Aussage aus:',
  '- Ein kurzer Satz im Präsens über den jetzigen Zustand, höchstens 120 Zeichen.',
  '- Genau eine Sache je Aussage. Steckt ein zweites Thema hinter einem "und" oder',
  '  einem Komma, sind es zwei Aussagen und gehören in zwei Zeilen.',
  '- Kein Arbeitsbericht. Nicht "Issue 33 ist umgesetzt", sondern was seitdem gilt:',
  '  "Die Nachbarsuche liegt auf GET /api/documents/:id/related und schreibt nichts."',
  '- Ohne Datum, ohne "wir haben", ohne "wurde".',
  '',
  'Regeln:',
  '- Eine Notiz darf mehrere Zeilen ergeben, höchstens vier. Nimm die haltbarsten.',
  '- Sagt eine Notiz etwas, das ein bekannter Fakt schon sagt: BESTAETIGT, niemals NEU.',
  '- Sagt sie, dass ein bekannter Fakt nicht mehr gilt und was stattdessen gilt: ERSETZT.',
  '- Steht sie im Widerspruch zu einem Fakt, ohne dass klar ist, was gilt: WIDERSPRUCH.',
  '- Enthält sie nichts, das über die Sitzung hinaus gilt: NICHTS, eine Zeile, sonst nichts.',
  '- Erfinde keine Ids.',
  '- Keine Gedankenstriche: Punkt, Komma, Doppelpunkt oder Klammern.',
].join('\n');

/**
 * Statements one note may produce.
 *
 * A distilled note holds three to eight bullet points and rarely says only one
 * thing. Forcing it into a single statement is how the first run produced
 * 200-character run-on sentences that answer nothing; four is enough for a
 * session and few enough that a chatty model cannot flood the memory.
 */
const MAX_VERDICTS_PER_NOTE = 4;
/** Longest statement kept. Beyond this it is a paragraph, not a claim. */
const MAX_STATEMENT_CHARS = 160;

/** Characters of one note handed to the judge. Enough for a distilled note. */
const MAX_NOTE_CHARS = 2_000;
/** Facts shown to the judge. Beyond this the prompt stops being readable. */
const MAX_KNOWN_FACTS = 40;
const JUDGE_MAX_TOKENS = 1_500;
const JUDGE_TIMEOUT_MS = 120_000;

export interface MemoryConsolidateDependencies {
  prisma: PrismaClient;
  provider: AiProvider;
  /** Acts as the user in the payload, like capture does. Null disables the job. */
  apiClientFor: ((userId: string) => ExocortexApiClient) | null;
  settings: (workspaceId?: string) => Promise<Settings>;
  defaultModel: string | null;
}

/**
 * Turns session notes into standing facts (issue #46).
 *
 * The split with the API is the same one capture uses and is deliberate: this
 * job decides what a note *means*, the API decides what that does to the
 * memory. Nothing here writes a page; `POST /api/memory/facts` does, with a
 * service token minted for the acting user, so a distilled fact passes exactly
 * the checks a hand-typed page passes (ADR-014, ADR-016).
 *
 * Like capture, nothing here throws for a foreseeable outcome. Nobody is
 * waiting on a nightly sweep, and a retry would pay for the same prompt twice.
 */
export function createMemoryConsolidateProcessor(dependencies: MemoryConsolidateDependencies) {
  return async ({
    payload,
    logger,
  }: JobContext<typeof QUEUE_NAMES.memoryConsolidate>): Promise<void> => {
    const settings = await dependencies.settings(payload.workspaceId);
    if (!settings['ai.enabled'] || !settings['memory.enabled']) return;
    if (!settings['memory.consolidationEnabled']) return;
    if (dependencies.apiClientFor === null) {
      logger.warn('Memory consolidation is unavailable: SERVICE_TOKEN_SECRET is not configured');
      return;
    }
    const notes = await unreadNotes({
      prisma: dependencies.prisma,
      projectDocumentId: payload.projectDocumentId,
      limit: settings['memory.consolidationNotesPerProject'],
    });
    if (notes.length === 0) return;

    const client = dependencies.apiClientFor(payload.userId);
    const known = await knownFacts(client, payload.projectKey);

    const model =
      settings['memory.consolidationModelSlug'] ??
      settings['memory.captureModelSlug'] ??
      settings['ai.compactionModelSlug'] ??
      settings['ai.defaultModelSlug'] ??
      dependencies.defaultModel ??
      undefined;

    let answer: string;
    try {
      const result = await dependencies.provider.generate({
        messages: [
          { role: 'system', content: JUDGE_PROMPT },
          { role: 'user', content: renderJudgeInput(known, notes) },
        ],
        model,
        maxOutputTokens: JUDGE_MAX_TOKENS,
        temperature: 0.1,
        correlationId: payload.correlationId,
        timeoutMs: JUDGE_TIMEOUT_MS,
      });
      answer = result.text;
    } catch (error) {
      logger.warn('Memory consolidation could not judge the notes', {
        project: payload.projectKey,
        model,
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const verdicts = parseVerdicts(answer, new Set(notes.map((note) => note.id)));

    try {
      const applied = await client.request({
        method: 'POST',
        path: '/api/memory/facts',
        body: { project: payload.projectKey, noteIds: notes.map((note) => note.id), verdicts },
        responseSchema: memoryConsolidateResponseSchema,
      });
      logger.info('Memory consolidated', {
        project: payload.projectKey,
        model,
        notesRead: applied.notesRead,
        created: applied.created,
        confirmed: applied.confirmed,
        superseded: applied.superseded,
        conflicted: applied.conflicted,
        discarded: applied.discarded,
        rejected: applied.rejected,
      });
    } catch (error) {
      logger.warn('Memory consolidation could not apply its verdicts', {
        project: payload.projectKey,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/**
 * The notes of one project that no run has read yet.
 *
 * Read straight from the database rather than through the API: this is a
 * read-only candidate query on the worker's own schedule, the same shape every
 * maintenance sweep uses, and routing it through HTTP would buy nothing.
 * `memoryFact: null` keeps the fact pages out: they hang under the same project
 * page and would otherwise be consolidated into facts about facts.
 */
async function unreadNotes(input: {
  prisma: PrismaClient;
  projectDocumentId: string;
  limit: number;
}): Promise<{ id: string; title: string; text: string }[]> {
  const rows = await input.prisma.document.findMany({
    where: {
      parentId: input.projectDocumentId,
      archivedAt: null,
      memoryConsolidation: { is: null },
      memoryFact: { is: null },
      // The `Fakten` page hangs here too and is not a note. It always has
      // children by the time a second run looks, because the first thing done
      // after creating it is putting a fact under it.
      children: { none: {} },
    },
    select: { id: true, title: true, content: { select: { plainText: true } } },
    orderBy: { createdAt: 'asc' },
    take: input.limit,
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    text: (row.content?.plainText ?? '').slice(0, MAX_NOTE_CHARS),
  }));
}

/** What the memory already holds, as the judge sees it. */
async function knownFacts(
  client: ExocortexApiClient,
  projectKey: string,
): Promise<{ id: string; statement: string }[]> {
  const listed = await client.request({
    method: 'GET',
    path: `/api/memory/facts?project=${encodeURIComponent(projectKey)}&limit=${MAX_KNOWN_FACTS}`,
    responseSchema: memoryFactListResponseSchema,
  });
  return listed.facts.map((fact) => ({ id: fact.id, statement: fact.statement }));
}

function renderJudgeInput(
  known: readonly { id: string; statement: string }[],
  notes: readonly { id: string; title: string; text: string }[],
): string {
  const factLines =
    known.length === 0
      ? 'Noch keine Fakten bekannt.'
      : known.map((fact) => `${fact.id} | ${fact.statement}`).join('\n');
  const noteBlocks = notes
    .map((note) => `### ${note.id}\n${note.title}\n${note.text}`.trim())
    .join('\n\n');
  return `## Bekannte Fakten\n${factLines}\n\n## Neue Notizen\n${noteBlocks}`;
}

/**
 * Reads the judge's answer back into verdicts.
 *
 * Strict where a mistake would be silent and forgiving where it would not. A
 * line naming a note outside the batch is dropped here rather than sent on to
 * be counted as rejected, because nothing downstream can tell it from a real
 * one. A note may say several things, up to `MAX_VERDICTS_PER_NOTE`, but only
 * one of them about any single fact: a model that confirms and replaces the
 * same fact in one breath has lost the thread, and applying both would leave
 * the memory holding two answers.
 */
export function parseVerdicts(answer: string, noteIds: ReadonlySet<string>): MemoryFactVerdict[] {
  const verdicts: MemoryFactVerdict[] = [];
  const perNote = new Map<string, number>();
  const touched = new Set<string>();

  for (const rawLine of answer.split('\n')) {
    const verdict = readVerdictLine(rawLine);
    if (verdict === null || !noteIds.has(verdict.noteId)) continue;
    if ((perNote.get(verdict.noteId) ?? 0) >= MAX_VERDICTS_PER_NOTE) continue;
    if (verdict.factId !== null && touched.has(verdict.factId)) continue;

    if (verdict.factId !== null) touched.add(verdict.factId);
    perNote.set(verdict.noteId, (perNote.get(verdict.noteId) ?? 0) + 1);
    verdicts.push(verdict);
  }

  return verdicts;
}

/**
 * One line, as far as it can be read on its own.
 *
 * Everything decidable from the line alone happens here: the shape, the
 * vocabulary, and whether the verdict carries what its kind needs. What the
 * line cannot know, whether the note is real and whether something was already
 * said about this fact, stays with the caller.
 */
function readVerdictLine(rawLine: string): MemoryFactVerdict | null {
  const parts = rawLine.split('|').map((part) => part.trim());
  if (parts.length < 4) return null;

  const [rawKind, noteId, rawFactId, rawStatement] = parts as [string, string, string, string];
  const kind = VERDICT_KINDS[rawKind.toUpperCase()];
  // `discard` is read and then dropped: it is the model saying there is nothing
  // here, and the note is marked as read by the batch, not by a verdict.
  if (kind === undefined || kind === 'discard') return null;

  const factId = rawFactId === '-' || rawFactId.length === 0 ? null : rawFactId;
  const statement = rawStatement === '-' || rawStatement.length === 0 ? null : rawStatement;
  if ((kind === 'new' || kind === 'supersedes') && statement === null) return null;
  if (kind !== 'new' && factId === null) return null;

  return {
    kind,
    noteId,
    factId,
    statement: statement === null ? null : trimStatement(statement),
    detail: '',
  };
}

/**
 * A statement, cut at a word boundary if it has to be cut at all.
 *
 * The first run produced sentences ending in "sowie gemeinsa", because a hard
 * slice lands wherever it lands. A statement is a page title and a person reads
 * it; half a word is worse than a missing clause.
 */
function trimStatement(statement: string): string {
  if (statement.length <= MAX_STATEMENT_CHARS) return statement;
  const cut = statement.slice(0, MAX_STATEMENT_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  const kept = lastSpace > MAX_STATEMENT_CHARS / 2 ? cut.slice(0, lastSpace) : cut;
  return `${kept.trimEnd()}…`;
}

const VERDICT_KINDS: Record<string, MemoryFactVerdict['kind'] | undefined> = {
  NEU: 'new',
  BESTAETIGT: 'confirms',
  BESTÄTIGT: 'confirms',
  ERSETZT: 'supersedes',
  WIDERSPRUCH: 'conflicts',
  NICHTS: 'discard',
};
