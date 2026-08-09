import { z } from 'zod';

import { type AiRun, aiRunSchema, idSchema } from '@exocortex/contracts';

import { truncateText } from '../format.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Watching and stopping an AI run from outside the browser.
 *
 * `docs/mcp.md` keeps AI *conversations* out of the catalogue on purpose: a
 * conversation is the assistant's own session, and steering it from another
 * assistant's transcript would be steering a second, unrelated chat. A run's
 * lifecycle is a different matter, and the reason is issue #6: a run that
 * looks alive but is not, or one that hangs, must be inspectable and
 * stoppable by whoever is looking at it -- and the browser panel is not the
 * only place somebody looks.
 *
 * Both tools are offered on the `mcp` surface only. Handing the built-in AI a
 * button that cancels a run would hand it, first of all, the button that
 * cancels itself.
 */

/** German label per wire status, so a model does not have to guess at the enum. */
const STATUS_LABEL: Record<AiRun['status'], string> = {
  pending: 'wartet auf einen Worker',
  running: 'läuft',
  completed: 'abgeschlossen',
  failed: 'fehlgeschlagen',
  cancelled: 'abgebrochen',
  timed_out: 'Zeitüberschreitung',
};

/** Cap on the answer excerpt, so a long run cannot flood a tool loop. */
const MAX_RESULT_TEXT_CHARS = 2_000;

function renderRun(run: AiRun): string {
  const lines = [
    `Lauf ${run.id}: ${STATUS_LABEL[run.status]}`,
    `Modell: ${run.model} (${run.provider}), Denkstufe: ${run.reasoningLevel}`,
    `Angelegt: ${run.createdAt}`,
    `Gestartet: ${run.startedAt ?? 'noch nicht'}`,
    `Letztes Lebenszeichen: ${run.heartbeatAt ?? 'keins'}`,
    `Beendet: ${run.finishedAt ?? 'noch nicht'}`,
    `Werkzeugrunden: ${String(run.toolIterations)}`,
  ];
  if (run.errorCode !== null) lines.push(`Fehlercode: ${run.errorCode}`);
  if (run.usage !== null) {
    lines.push(
      `Tokens: ${String(run.usage.inputTokens)} hinein, ${String(run.usage.outputTokens)} hinaus`,
    );
  }
  if (run.resultText !== null && run.resultText.length > 0) {
    const label =
      run.status === 'pending' || run.status === 'running'
        ? 'Antwort bisher'
        : 'Antwort';
    lines.push(`${label}:\n${truncateText(run.resultText, MAX_RESULT_TEXT_CHARS).text}`);
  }
  return lines.join('\n');
}

export const aiRunGetTool: AnyToolDefinition = defineTool({
  name: 'exo_ai_run_get',
  description:
    'Liest den Zustand eines KI-Laufs: Status, Modell, Startzeit, letztes Lebenszeichen ' +
    '(heartbeatAt), Werkzeugrunden, Fehlercode und die bisher erzeugte Antwort. Damit lässt ' +
    'sich unterscheiden, ob ein Lauf noch arbeitet oder längst beendet ist.',
  inputSchema: z.object({ runId: idSchema }),
  surfaces: ['mcp'],
  mutating: false,
  async execute(client, input) {
    const run = await client.request({
      method: 'GET',
      path: `/api/ai/runs/${input.runId}`,
      responseSchema: aiRunSchema,
    });
    return { text: renderRun(run), data: run };
  },
});

export const aiRunCancelTool: AnyToolDefinition = defineTool({
  name: 'exo_ai_run_cancel',
  description:
    'Bricht einen wartenden oder laufenden KI-Lauf ab. Ein bereits beendeter Lauf wird nicht ' +
    'angetastet, der Aufruf meldet dann einen Konflikt. Der Worker merkt den Abbruch beim ' +
    'nächsten Lebenszeichen und beendet seine Arbeit.',
  inputSchema: z.object({ runId: idSchema }),
  surfaces: ['mcp'],
  mutating: true,
  target: (input) => `ai_run:${input.runId}`,
  async execute(client, input) {
    const run = await client.request({
      method: 'POST',
      path: `/api/ai/runs/${input.runId}/cancel`,
      responseSchema: aiRunSchema,
    });
    return { text: `Lauf ${run.id} abgebrochen (${STATUS_LABEL[run.status]}).`, data: run };
  },
});

export const AI_RUN_TOOLS: readonly AnyToolDefinition[] = [aiRunGetTool, aiRunCancelTool];
