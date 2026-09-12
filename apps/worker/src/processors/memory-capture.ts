import { type AiProvider } from '@exocortex/ai';
import {
  memoryRememberResponseSchema,
  type QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type JobContext } from '@exocortex/queue';

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
const DISTILL_PROMPT = [
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

/** Cap for the transcript handed to the model, from the end (the recent part matters). */
const MAX_TRANSCRIPT_CHARS = 60_000;
/** Cap for the distilled note. A memory that needs more than this is not distilled. */
const MAX_NOTE_TOKENS = 900;
/** The distiller gets its own timeout: nobody is waiting, but nothing may hang forever. */
const DISTILL_TIMEOUT_MS = 120_000;

export interface MemoryCaptureDependencies {
  provider: AiProvider;
  /**
   * An API client acting as the given user. `null` when the deployment has no
   * service-token secret, which is the same seam that disables the tool loop.
   */
  apiClientFor: ((userId: string) => ExocortexApiClient) | null;
  settings: (workspaceId?: string) => Promise<Settings>;
  /**
   * Fallback model when no setting names one, usually `OPENROUTER_DEFAULT_MODEL`.
   * `null` leaves the choice to the provider, which has a default of its own.
   */
  defaultModel: string | null;
}

/**
 * Turns one finished working session into one memory note (issue #34, AP1).
 *
 * The raw transcript exists only here, in the job payload, for as long as the
 * job runs. What gets written is the model's summary, through
 * `POST /api/memory/remember` with a service token minted for the capturing
 * user, so an automatically written memory passes exactly the permission checks
 * a hand-typed page does (ADR-014).
 *
 * Nothing here throws for a foreseeable outcome. The caller is a hook inside
 * somebody's editor that has long since exited; a failed capture is a memory
 * that was not written, not an incident, and a retry would only pay for the
 * same prompt twice.
 */
export function createMemoryCaptureProcessor(dependencies: MemoryCaptureDependencies) {
  return async ({
    payload,
    logger,
  }: JobContext<typeof QUEUE_NAMES.memoryCapture>): Promise<void> => {
    const settings = await dependencies.settings(payload.workspaceId);

    if (!settings['ai.enabled'] || !settings['memory.enabled']) {
      logger.info('Memory capture skipped: the feature is switched off', {
        project: payload.projectKey,
      });
      return;
    }
    if (dependencies.apiClientFor === null) {
      logger.warn('Memory capture is unavailable: SERVICE_TOKEN_SECRET is not configured');
      return;
    }

    const model =
      settings['memory.captureModelSlug'] ??
      settings['ai.compactionModelSlug'] ??
      settings['ai.defaultModelSlug'] ??
      dependencies.defaultModel ??
      undefined;

    const transcript = tailOf(payload.transcript, MAX_TRANSCRIPT_CHARS);
    const context = [
      `Projekt: ${payload.projectKey}`,
      `Client: ${payload.client}`,
      ...(payload.hint === null ? [] : [`Hinweis des Clients: ${payload.hint}`]),
    ].join('\n');

    let answer: string;
    try {
      const result = await dependencies.provider.generate({
        messages: [
          { role: 'system', content: DISTILL_PROMPT },
          { role: 'user', content: `${context}\n\n---\n\n${transcript}` },
        ],
        model,
        maxOutputTokens: MAX_NOTE_TOKENS,
        temperature: 0.2,
        correlationId: payload.correlationId,
        timeoutMs: DISTILL_TIMEOUT_MS,
      });
      answer = result.text;
    } catch (error) {
      logger.warn('Memory capture failed to distil the session', {
        project: payload.projectKey,
        model,
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const note = parseNote(answer);
    if (note === null) {
      logger.info('Memory capture found nothing worth remembering', {
        project: payload.projectKey,
        client: payload.client,
      });
      return;
    }

    try {
      const written = await dependencies.apiClientFor(payload.userId).request({
        method: 'POST',
        path: '/api/memory/remember',
        body: {
          project: payload.projectKey,
          title: note.title,
          text: note.body,
          client: payload.client,
          // One page per session, not one per day: a session is the unit a
          // person recognises again, and its bullet points only make sense
          // together.
          appendToday: false,
        },
        responseSchema: memoryRememberResponseSchema,
      });

      logger.info('Session captured as a memory', {
        project: payload.projectKey,
        client: payload.client,
        documentId: written.documentId,
        model,
        transcriptChars: payload.transcript.length,
        noteChars: note.body.length,
      });
    } catch (error) {
      logger.warn('Memory capture could not write the note', {
        project: payload.projectKey,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/** The last `max` characters, cut at a line boundary so no line arrives halved. */
function tailOf(transcript: string, max: number): string {
  if (transcript.length <= max) return transcript;
  const tail = transcript.slice(transcript.length - max);
  const firstBreak = tail.indexOf('\n');
  return firstBreak === -1 ? tail : tail.slice(firstBreak + 1);
}

/**
 * Reads the model's answer back into a title and a body.
 *
 * Tolerant on purpose: a missing `TITEL:` line is a formatting slip, not a
 * reason to drop a memory that was already paid for. `NICHTS` is the one answer
 * that means "write nothing", and it is checked before anything else.
 */
export function parseNote(answer: string): { title: string; body: string } | null {
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
