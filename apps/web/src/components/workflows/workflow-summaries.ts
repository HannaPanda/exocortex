'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AgentProfile,
  isInputSource,
  workflowAgentNodeEffect,
  type WorkflowEnvelope,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowProblem,
  type WorkflowSchedule,
  type WorkspaceMember,
} from '@exocortex/contracts';

import { useAutomationWording } from '../automations/automation-labels';

import { type WorkflowNodeDecoration } from './workflow-canvas';
import { useWorkflowWording } from './workflow-labels';

/**
 * The one line a node card says about itself (issue #164), and the
 * consequential setting it shows as a badge: an agent's effective write mode,
 * because that is the question somebody looking at a graph has to be able to
 * answer without opening every node.
 */
export function useNodeDecorations({
  graph,
  problems,
  envelope,
  profiles,
  members,
}: {
  graph: WorkflowGraph;
  problems: readonly WorkflowProblem[];
  envelope: WorkflowEnvelope | null;
  profiles: readonly AgentProfile[];
  members: readonly WorkspaceMember[];
}): Map<string, WorkflowNodeDecoration> {
  const summary = useNodeSummary(members);
  const modeWording = useWorkflowWording();
  const t = useTranslations('workflows.summary');
  return React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const problem of problems) {
      if (problem.nodeId !== null)
        counts.set(problem.nodeId, (counts.get(problem.nodeId) ?? 0) + 1);
    }
    const map = new Map<string, WorkflowNodeDecoration>();
    for (const node of graph.nodes) {
      const badge =
        node.type === 'agent' && envelope !== null
          ? t('writeModeBadge', {
              mode: modeWording.writeMode(
                workflowAgentNodeEffect({ node, envelope, profiles }).writeMode,
              ),
            })
          : null;
      map.set(node.id, {
        summary: summary(node, graph),
        badge,
        problems: counts.get(node.id) ?? 0,
      });
    }
    return map;
  }, [envelope, graph, modeWording, problems, profiles, summary, t]);
}

export function useNodeSummary(members: readonly WorkspaceMember[]) {
  const t = useTranslations('workflows.summary');
  const tCondition = useTranslations('workflows.condition');
  const automation = useAutomationWording();
  return React.useCallback(
    (node: WorkflowNode, graph: WorkflowGraph): string | null => {
      switch (node.type) {
        case 'trigger.manual':
          return t('manual');
        case 'trigger.schedule':
          return automation.schedule(describeSchedule(node.schedule));
        case 'trigger.event':
          return node.events.length === 0
            ? t('eventNone')
            : node.events.map((event) => automation.trigger(event)).join(', ');
        case 'agent':
          return node.goal.trim().length === 0 ? t('goalMissing') : excerpt(node.goal);
        case 'condition': {
          const source = isInputSource(node.source)
            ? t('inputSource', { key: node.source.input })
            : `${node.source.nodeId}.${node.source.field}`;
          const operator = tCondition(`operators.${node.operator}`);
          return node.value === null
            ? `${source} ${operator}`
            : `${source} ${operator} ${String(node.value)}`;
        }
        case 'parallel':
          return t('branches', {
            count: graph.edges.filter((edge) => edge.source.nodeId === node.id).length,
          });
        case 'join':
          return t(`join.${node.policy}`);
        case 'approval': {
          const who =
            node.assigneeUserId === null
              ? t('approvalAnybody')
              : (members.find((member) => member.userId === node.assigneeUserId)?.name ??
                t('approvalGone'));
          const text = node.title.trim() || node.question.trim();
          return text.length === 0 ? t('questionMissing') : `${excerpt(text)} · ${who}`;
        }
        case 'end':
          return t(`end.${node.outcome}`);
      }
    },
    [automation, members, t, tCondition],
  );
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
}

/** A workflow schedule in the shape the automation wording describes. */
function describeSchedule(schedule: WorkflowSchedule) {
  return {
    scheduleKind: schedule.kind,
    scheduleAt: schedule.kind === 'ONCE' ? schedule.at : null,
    scheduleTime: 'time' in schedule ? schedule.time : null,
    scheduleWeekday: schedule.kind === 'WEEKLY' ? schedule.weekday : null,
    scheduleDayOfMonth: schedule.kind === 'MONTHLY' ? schedule.dayOfMonth : null,
    scheduleCron: schedule.kind === 'CRON' ? schedule.cron : null,
    scheduleTimeZone: schedule.timeZone,
  };
}
