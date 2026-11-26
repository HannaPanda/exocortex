import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AiRunPhase } from '@exocortex/contracts';

import { useDocument } from '@/lib/api/document-queries';

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
  | 'phase.retrying'
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
  if (phase === 'retrying') return { key: 'phase.retrying' };
  return { key: streamText.length > 0 ? 'phase.writing' : 'phase.generating' };
}

/**
 * The page the run's current tool call is about, while that call runs
 * (issue #248): what the pulse names and links to. `writing` when the call
 * changes the page (its target is the page), reading otherwise. `null` when
 * no call is running or the running one is not about a page.
 */
export function currentToolPage(
  toolActivity: readonly ToolActivityEntry[],
): { documentId: string; writing: boolean } | null {
  const last = toolActivity[toolActivity.length - 1];
  if (last === undefined || last.status !== 'started') return null;
  const target = describeToolTarget(last.target);
  if (target?.kind === 'document') return { documentId: target.id, writing: true };
  const subject = describeToolTarget(last.subject);
  if (subject?.kind === 'document') return { documentId: subject.id, writing: false };
  return null;
}

/**
 * The pulse's phase when the page has a line of its own below it
 * (issue #248): the tool keeps its name, the page is said once, by title.
 */
export function phaseWithoutPage(
  toolActivity: readonly ToolActivityEntry[],
  streamText: string,
  phase: AiRunPhase | null,
): RunLabel {
  const label = currentPhaseLabel(toolActivity, streamText, phase);
  return currentToolPage(toolActivity) === null ? label : { ...label, target: null };
}

/** The slice of a translator bound to `ai.run` that resolving a label needs. */
export type RunTranslator = (
  key: RunLabelKey | 'target.document' | 'target.documentTitled' | 'target.workspace',
  values?: Record<string, string>,
) => string;

/**
 * A run label in words, given a translator bound to `ai.run`. A page the
 * reader can open is named by its title (issue #248); `titleOf` answers
 * `null` for one it cannot, which keeps the id.
 */
export function resolveRunLabel(
  t: RunTranslator,
  label: RunLabel,
  titleOf: (documentId: string) => string | null = () => null,
): string {
  const target = label.target ?? null;
  let targetText = '';
  if (target?.kind === 'raw') targetText = target.text;
  else if (target?.kind === 'workspace') targetText = t('target.workspace', { id: target.id });
  else if (target?.kind === 'document') {
    const title = titleOf(target.id);
    targetText =
      title === null
        ? t('target.document', { id: target.id })
        : t('target.documentTitled', { title });
  }
  return t(label.key, {
    tool: label.tool ?? '',
    hasTarget: target === null ? 'no' : 'yes',
    target: targetText,
  });
}

/** `resolveRunLabel` with the reader's language already bound. */
export function useRunLabels(): (
  label: RunLabel,
  titleOf?: (documentId: string) => string | null,
) => string {
  const t = useTranslations('ai.run');
  return React.useCallback(
    (label: RunLabel, titleOf?: (documentId: string) => string | null) =>
      resolveRunLabel(t, label, titleOf),
    [t],
  );
}

/**
 * The title of a page a run line names, when the reader may open it. Read
 * through the ordinary document query, so the same page named twenty times in
 * one trace is asked for once, and a page the reader cannot see stays an id.
 */
export function usePageTitle(documentId: string | null): string | null {
  // Only something shaped like an id is asked for: a target the panel was
  // handed in a fixture or by an older worker is named as it came.
  const askable = documentId !== null && /^[a-z0-9]{16,40}$/.test(documentId);
  const document = useDocument(askable ? documentId : undefined);
  return document.data?.title ?? null;
}
