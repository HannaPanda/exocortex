/**
 * Turning a working session into one memory note.
 *
 * Lives here rather than in the capture processor because two callers now ask
 * the same question of a model and must get the same kind of answer: the
 * `memory-capture` job, which distils a finished session after the fact, and
 * `POST /api/memory/checkpoint`, which distils the part of a running session
 * that is about to be compacted away (issue #92). Two prompts would drift, and
 * the day they drift a recall starts showing two different shapes of note for
 * what is the same thing.
 */

/**
 * What the distiller is asked for.
 *
 * Two rules carry the weight. The first line must be a title, because a page
 * called "Sitzung vom 12.08." tells a later recall nothing and a title is what
 * ranks highest in the search index. And the model is explicitly allowed to
 * answer that there is nothing worth keeping: an agent memory that grows with
 * every "fixed a typo" session gets worse at recall, not better, so the filter
 * belongs where the content is understood.
 */
export const MEMORY_DISTILL_PROMPT = [
  'Du destillierst eine beendete Arbeitssitzung eines Programmier-Agenten zu einer Erinnerung.',
  'Die Erinnerung wird in späteren Sitzungen wieder eingespielt, wenn jemand am selben Projekt arbeitet.',
  '',
  'Antworte genau in diesem Format:',
  'TITEL: <eine Zeile, konkret, ohne Datum>',
  '<Leerzeile>',
  '<3 bis 8 Stichpunkte auf Deutsch, beginnend mit "- ">',
  '',
  'Behalte: getroffene Entscheidungen und ihre Begründung, Dateipfade, IDs, Befehle, Stolperfallen,',
  'offene Punkte. Lass weg: Höflichkeiten, Wiederholungen, Werkzeugausgaben, den Wortlaut des Gesprächs.',
  'Schreibe nichts, was in der nächsten Sitzung ohnehin im Code steht.',
  'Keine Gedankenstriche, auch nicht im Titel: Punkt, Komma, Doppelpunkt oder Klammern.',
  '',
  'Wenn die Sitzung nichts enthält, das später jemandem hilft, antworte nur mit: NICHTS',
].join('\n');

/**
 * The same instruction for a checkpoint, which is the middle of a session and
 * not its end.
 *
 * A separate line rather than a separate prompt: the shape of the answer has to
 * stay identical, because both kinds of note end up side by side under the same
 * project page and a recall must not be able to tell them apart by formatting.
 * What differs is the honest framing, and a model told "this session continues"
 * keeps open threads instead of writing a closing summary of a thing that has
 * not closed.
 */
export const MEMORY_CHECKPOINT_PROMPT = [
  MEMORY_DISTILL_PROMPT,
  '',
  'Diese Sitzung läuft noch. Du siehst den Teil des Verlaufs, der gleich verdichtet wird',
  'und danach nicht mehr im Kontext steht. Halte deshalb besonders fest, was später',
  'noch gebraucht wird: offene Aufgaben, Zwischenstände, Entscheidungen und Kennungen.',
].join('\n');

/** Cap for the transcript handed to the model, from the end (the recent part matters). */
export const MAX_DISTILL_TRANSCRIPT_CHARS = 60_000;

/** Cap for the distilled note. A memory that needs more than this is not distilled. */
export const MAX_DISTILL_NOTE_TOKENS = 900;

/** A distilled note: the page title and the bullet points under it. */
export interface DistilledNote {
  title: string;
  body: string;
}

/**
 * Reads the model's answer back into a title and a body.
 *
 * Tolerant on purpose: a missing `TITEL:` line is a formatting slip, not a
 * reason to drop a memory that was already paid for. `NICHTS` is the one answer
 * that means "write nothing", and it is checked before anything else.
 */
export function parseMemoryNote(answer: string): DistilledNote | null {
  const trimmed = answer.trim();
  if (trimmed.length === 0) return null;
  if (/^nichts[.!]?$/i.test(trimmed)) return null;

  const lines = trimmed.split('\n');
  const first = lines[0]?.trim() ?? '';
  const titleMatch = /^TITEL:\s*(.+)$/i.exec(first);

  if (titleMatch !== null) {
    const title = titleMatch[1]!.trim().slice(0, 200);
    const body = lines.slice(1).join('\n').trim();
    return body.length === 0 ? null : { title, body };
  }

  // No title line: use the first sentence as the title and keep everything as
  // the body, so nothing the model wrote is lost.
  const fallbackTitle = first.replace(/^[-*#\s]+/, '').slice(0, 200);
  return {
    title: fallbackTitle.length === 0 ? 'Sitzungsnotiz' : fallbackTitle,
    body: trimmed,
  };
}

/** The last `max` characters, cut at a line boundary so no line arrives halved. */
export function transcriptTail(transcript: string, max: number): string {
  if (transcript.length <= max) return transcript;
  const tail = transcript.slice(transcript.length - max);
  const firstBreak = tail.indexOf('\n');
  return firstBreak === -1 ? tail : tail.slice(firstBreak + 1);
}

/**
 * The context block above the transcript.
 *
 * Shared so a checkpoint and a capture describe their session the same way. The
 * model reads this as facts about the session, never as instructions.
 */
export function renderDistillContext(input: {
  projectKey: string;
  client: string;
  hint: string | null;
}): string {
  return [
    `Projekt: ${input.projectKey}`,
    `Client: ${input.client}`,
    ...(input.hint === null ? [] : [`Hinweis des Clients: ${input.hint}`]),
  ].join('\n');
}
