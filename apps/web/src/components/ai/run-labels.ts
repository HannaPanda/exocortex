import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AiRunPhase } from '@exocortex/contracts';

import { type ToolActivityEntry } from './use-ai-run-tracker';

/**
 * What a running answer says about itself: one line per tool call, and the
 * phase shown in the run's pulse. The decisions are pure and return a message
 * key with its arguments, so the choice can be tested without a panel around
 * it (split out of `ai-panel.tsx`, issue #97); `useRunLabels` turns them into
 * the reader's language.
 */

/** The messages under `ai.run` a run label can resolve to. */
export type RunLabelKey =
  | `toolLine.${ToolActivityEntry['status']}`
  | 'phase.tool'
  | 'phase.reasoning'
  | 'phase.compacting'
  | 'phase.writing'
  | 'phase.generating';

/** A tool's compact target, split into what the message needs. */
export type RunTarget =
  | { kind: 'document' | 'workspace'; id: string }
  /** A target this panel does not know how to name is passed through as it came. */
  | { kind: 'raw'; text: string };

export interface RunLabel {
  key: RunLabelKey;
  tool?: string;
  target?: RunTarget | null;
}

/** Turns a tool's compact target (`document:<id>`, `workspace:<id>`) into its parts. */
export function describeToolTarget(target: string | null): RunTarget | null {
  if (target === null) return null;
  const separatorIndex = target.indexOf(':');
  if (separatorIndex === -1) return { kind: 'raw', text: target };
  const kind = target.slice(0, separatorIndex);
  const id = target.slice(separatorIndex + 1);
  if (kind === 'document' || kind === 'workspace') return { kind, id };
  return { kind: 'raw', text: `${kind} ${id}` };
}

export function toolActivityLine(entry: ToolActivityEntry): RunLabel {
  return {
    key: `toolLine.${entry.status}`,
    tool: entry.toolName,
    target: describeToolTarget(entry.target),
  };
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
): RunLabel {
  const last = toolActivity[toolActivity.length - 1];
  if (last !== undefined && last.status === 'started') {
    return { key: 'phase.tool', tool: last.toolName, target: describeToolTarget(last.target) };
  }
  if (phase === 'reasoning') return { key: 'phase.reasoning' };
  if (phase === 'compacting') return { key: 'phase.compacting' };
  return { key: streamText.length > 0 ? 'phase.writing' : 'phase.generating' };
}

/** The slice of a translator bound to `ai.run` that resolving a label needs. */
export type RunTranslator = (
  key: RunLabelKey | 'target.document' | 'target.workspace',
  values?: Record<string, string>,
) => string;

/** A run label in words, given a translator bound to `ai.run`. */
export function resolveRunLabel(t: RunTranslator, label: RunLabel): string {
  const target = label.target ?? null;
  const targetText =
    target === null
      ? ''
      : target.kind === 'raw'
        ? target.text
        : t(`target.${target.kind}`, { id: target.id });
  return t(label.key, {
    tool: label.tool ?? '',
    hasTarget: target === null ? 'no' : 'yes',
    target: targetText,
  });
}

/** `resolveRunLabel` with the reader's language already bound. */
export function useRunLabels(): (label: RunLabel) => string {
  const t = useTranslations('ai.run');
  return React.useCallback((label: RunLabel) => resolveRunLabel(t, label), [t]);
}
