'use client';

import { CircleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { type WorkflowGraph, type WorkflowProblem } from '@exocortex/contracts';
import { cn } from '@exocortex/ui';

import { useWorkflowWording } from './workflow-labels';

/**
 * What stands between a draft and publishing (issue #164), each problem
 * naming the node or line it is about. Choosing one selects that element on
 * the canvas, so a person reads the sentence and lands on the thing to fix.
 */
export function WorkflowProblemList({
  problems,
  graph,
  onSelect,
  compact = false,
}: {
  problems: readonly WorkflowProblem[];
  graph: WorkflowGraph;
  onSelect: (problem: WorkflowProblem) => void;
  /** Inside a node's own panel the element is already known. */
  compact?: boolean;
}) {
  const t = useTranslations('workflows.problems');
  const wording = useWorkflowWording();
  const nameOf = (id: string): string =>
    graph.nodes.find((candidate) => candidate.id === id)?.label ?? id;
  const where = (problem: WorkflowProblem): string | null => {
    if (problem.nodeId !== null) {
      const node = graph.nodes.find((candidate) => candidate.id === problem.nodeId);
      return t('atNode', { node: node?.label ?? problem.nodeId });
    }
    if (problem.edgeId !== null) {
      const edge = graph.edges.find((candidate) => candidate.id === problem.edgeId);
      return edge === undefined
        ? t('atEdge', { from: problem.edgeId, to: '?' })
        : t('atEdge', { from: nameOf(edge.source.nodeId), to: nameOf(edge.target.nodeId) });
    }
    return problem.path === null ? null : t('atPath', { path: problem.path.join('.') });
  };

  return (
    <ul className="flex flex-col gap-1" aria-label={t('listLabel')} data-testid="workflow-problems">
      {problems.map((problem, index) => {
        const location = compact ? null : where(problem);
        const selectable = problem.nodeId !== null || problem.edgeId !== null;
        const body = (
          <>
            <CircleAlertIcon
              className="mt-0.5 size-3.5 shrink-0 text-destructive-text"
              aria-hidden
            />
            <span className="min-w-0">
              <span className="block">{wording.problem(problem)}</span>
              {location === null ? null : (
                <span className="block text-xs text-muted-foreground">{location}</span>
              )}
            </span>
          </>
        );
        return (
          <li
            key={`${problem.code}-${problem.nodeId ?? ''}-${problem.edgeId ?? ''}-${String(index)}`}
          >
            {selectable && !compact ? (
              <button
                type="button"
                className={cn(
                  'flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-sm',
                  'hover:bg-accent-solid',
                )}
                data-testid="workflow-problem"
                data-code={problem.code}
                onClick={() => onSelect(problem)}
              >
                {body}
              </button>
            ) : (
              <div
                className="flex items-start gap-2 px-2 py-1 text-sm"
                data-testid="workflow-problem"
                data-code={problem.code}
              >
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
