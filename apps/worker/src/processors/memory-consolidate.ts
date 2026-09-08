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
  'Entscheide für jede Notiz, was sie mit dem Faktenwissen macht.',
  '',
  'Antworte ausschließlich mit Zeilen in diesem Format, eine Zeile je Entscheidung:',
  'NEU | <notizId> | - | <Aussage in einem Satz>',
  'BESTAETIGT | <notizId> | <faktId> | -',
  'ERSETZT | <notizId> | <faktId> | <neue Aussage in einem Satz>',
  'WIDERSPRUCH | <notizId> | <faktId> | -',
  'NICHTS | <notizId> | - | -',
  '',
  'Regeln:',
  '- Sagt eine Notiz etwas, das ein bekannter Fakt schon sagt: BESTAETIGT, niemals NEU.',
  '- Sagt sie, dass ein bekannter Fakt nicht mehr gilt und was stattdessen gilt: ERSETZT.',
  '- Steht sie im Widerspruch zu einem Fakt, ohne dass klar ist, was gilt: WIDERSPRUCH.',
  '- Beschreibt sie nur, was jemand getan hat, statt was gilt: NICHTS.',
  '- Eine Aussage ist ein Satz im Präsens, ohne Datum, ohne "wir haben".',
  '- Höchstens eine Zeile je Notiz. Erfinde keine Ids.',
  '- Keine Gedankenstriche: Punkt, Komma, Doppelpunkt oder Klammern.',
].join('\n');

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
  settings: () => Promise<Settings>;
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
    const settings = await dependencies.settings();
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
 * Strict where a mistake would be silent and forgiving where it would not: a
 * line naming a note outside the batch is dropped here rather than sent on to
 * be counted as rejected, and a second line about the same note is dropped
 * because a note that both confirms and replaces something is a model that has
 * lost the thread.
 */
export function parseVerdicts(answer: string, noteIds: ReadonlySet<string>): MemoryFactVerdict[] {
  const verdicts: MemoryFactVerdict[] = [];
  const seen = new Set<string>();

  for (const rawLine of answer.split('\n')) {
    const parts = rawLine.split('|').map((part) => part.trim());
    if (parts.length < 4) continue;

    const [rawKind, noteId, rawFactId, rawStatement] = parts as [string, string, string, string];
    const kind = VERDICT_KINDS[rawKind.toUpperCase()];
    if (kind === undefined) continue;
    if (!noteIds.has(noteId) || seen.has(noteId)) continue;

    const factId = rawFactId === '-' || rawFactId.length === 0 ? null : rawFactId;
    const statement = rawStatement === '-' || rawStatement.length === 0 ? null : rawStatement;

    if (kind === 'discard') {
      seen.add(noteId);
      continue;
    }
    if ((kind === 'new' || kind === 'supersedes') && statement === null) continue;
    if (kind !== 'new' && factId === null) continue;

    seen.add(noteId);
    verdicts.push({
      kind,
      noteId,
      factId,
      statement: statement?.slice(0, 200) ?? null,
      detail: '',
    });
  }

  return verdicts;
}

const VERDICT_KINDS: Record<string, MemoryFactVerdict['kind'] | undefined> = {
  NEU: 'new',
  BESTAETIGT: 'confirms',
  BESTÄTIGT: 'confirms',
  ERSETZT: 'supersedes',
  WIDERSPRUCH: 'conflicts',
  NICHTS: 'discard',
};
