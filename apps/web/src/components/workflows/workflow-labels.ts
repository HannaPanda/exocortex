'use client';

import {
  BotIcon,
  CalendarClockIcon,
  CircleStopIcon,
  GitBranchIcon,
  GitForkIcon,
  GitMergeIcon,
  HandIcon,
  type LucideIcon,
  PlayIcon,
  ZapIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type WorkflowErrorClass,
  type WorkflowNodeType,
  type WorkflowProblem,
  type WorkflowRunOrigin,
  type WorkflowRunStatus,
} from '@exocortex/contracts';

import { type WorkflowNodeRunState } from './workflow-run-view';

/**
 * The words and marks a workflow is shown in (issue #164), shared by the
 * list, the editor and the run debugger, so a node is called the same thing
 * in the palette, on the canvas and in a problem.
 *
 * A node type's id contains a dot (`trigger.manual`), which the message
 * catalogue reads as a path, so the catalogue keys are the short names below.
 */
const TYPE_KEYS = {
  'trigger.manual': 'manual',
  'trigger.schedule': 'schedule',
  'trigger.event': 'event',
  agent: 'agent',
  condition: 'condition',
  parallel: 'parallel',
  join: 'join',
  approval: 'approval',
  end: 'end',
} as const satisfies Readonly<Record<WorkflowNodeType, string>>;

export const NODE_ICONS: Readonly<Record<WorkflowNodeType, LucideIcon>> = {
  'trigger.manual': PlayIcon,
  'trigger.schedule': CalendarClockIcon,
  'trigger.event': ZapIcon,
  agent: BotIcon,
  condition: GitBranchIcon,
  parallel: GitForkIcon,
  join: GitMergeIcon,
  approval: HandIcon,
  end: CircleStopIcon,
};

export function useWorkflowWording() {
  const t = useTranslations('workflows.labels');
  return React.useMemo(
    () => ({
      type: (type: WorkflowNodeType): string => t(`types.${TYPE_KEYS[type]}`),
      typeHint: (type: WorkflowNodeType): string => t(`typeHints.${TYPE_KEYS[type]}`),
      group: (group: 'trigger' | 'work' | 'control'): string => t(`groups.${group}`),
      handle: (handle: string): string =>
        ['next', 'true', 'false', 'branch', 'approved', 'rejected'].includes(handle)
          ? t(`handles.${handle}` as 'handles.next')
          : handle,
      runStatus: (status: WorkflowRunStatus): string => t(`runStatus.${status}`),
      nodeState: (state: WorkflowNodeRunState): string => t(`nodeState.${state}`),
      origin: (origin: WorkflowRunOrigin): string => t(`origin.${origin}`),
      errorClass: (value: WorkflowErrorClass): string => t(`errorClass.${value}`),
      /** A problem in the reader's words; the code decides, never the English message. */
      problem: (problem: WorkflowProblem): string => t(`problems.${problem.code}`),
    }),
    [t],
  );
}

export type WorkflowWording = ReturnType<typeof useWorkflowWording>;

/** The badge a run's status is shown in; the colour is a token, the word carries it too. */
export function runStatusVariant(
  status: WorkflowRunStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'succeeded') return 'default';
  if (status === 'failed' || status === 'timed_out') return 'destructive';
  if (status === 'cancelled') return 'outline';
  return 'secondary';
}
