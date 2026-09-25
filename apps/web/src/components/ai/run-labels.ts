import { type AiRunPhase } from '@exocortex/contracts';

import { type ToolActivityEntry } from './use-ai-run-tracker';

/**
 * What a running answer says about itself, in German: one line per tool call,
 * and the phase shown in the run's pulse. Pure, so the wording can be tested
 * without a panel around it (split out of `ai-panel.tsx`, issue #97).
 */

/** Turns a tool's compact target (`document:<id>`, `workspace:<id>`) into a short German phrase. */
function describeToolTarget(target: string | null): string | null {
  if (target === null) return null;
  const separatorIndex = target.indexOf(':');
  if (separatorIndex === -1) return target;
  const kind = target.slice(0, separatorIndex);
  const id = target.slice(separatorIndex + 1);
  const label = kind === 'document' ? 'Seite' : kind === 'workspace' ? 'Arbeitsbereich' : kind;
  return `${label} ${id}`;
}

/** What one line of tool activity ends with, per status. */
const TOOL_STATUS_SUFFIX: Record<ToolActivityEntry['status'], string> = {
  started: 'wird ausgeführt …',
  succeeded: '… fertig',
  failed: '… fehlgeschlagen',
  // Not a failure: the run had read content from outside and is therefore not
  // allowed to change anything any more (issue #56).
  refused: '… abgelehnt, weil dieser Lauf Fremdinhalte gelesen hat',
};

export function toolActivityLine(entry: ToolActivityEntry): string {
  const suffix = TOOL_STATUS_SUFFIX[entry.status];
  const targetLabel = describeToolTarget(entry.target);
  const targetSuffix = targetLabel === null ? '' : ` (${targetLabel})`;
  return `Werkzeug ${entry.toolName}${targetSuffix} ${suffix}`;
}

/**
 * Phase shown in the run's pulse while it is active.
 *
 * A tool in flight wins, because it is the most concrete thing to say. After
 * that comes whatever the worker last reported about itself: thinking and
 * compaction produce no text at all, and being able to name them is the
 * difference between a legitimate silence and a run that looks dead
 * (issue #6).
 */
export function currentPhaseLabel(
  toolActivity: readonly ToolActivityEntry[],
  streamText: string,
  phase: AiRunPhase | null,
): string {
  const last = toolActivity[toolActivity.length - 1];
  if (last !== undefined && last.status === 'started') {
    const targetLabel = describeToolTarget(last.target);
    return `Werkzeug ${last.toolName}${targetLabel === null ? '' : ` (${targetLabel})`} wird ausgeführt`;
  }
  if (phase === 'reasoning') return 'KI denkt nach';
  if (phase === 'compacting') return 'Älterer Verlauf wird zusammengefasst';
  return streamText.length > 0 ? 'Antwort wird geschrieben' : 'Antwort wird erzeugt';
}
