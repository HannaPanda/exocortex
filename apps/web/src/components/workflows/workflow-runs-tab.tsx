'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { useWorkflowRuns } from '@/lib/api/workflow-queries';

import { useRunFormat } from '../runs/run-inspector-format';

import { runStatusVariant, useWorkflowWording } from './workflow-labels';

/** The latest runs of a workflow (issue #164), each a way into its debugger. */
export function WorkflowRunsTab({
  workspaceId,
  workflowId,
}: {
  workspaceId: string;
  workflowId: string;
}) {
  const t = useTranslations('workflows.runs');
  const wording = useWorkflowWording();
  const format = useRunFormat();
  const runs = useWorkflowRuns(workflowId);

  if (runs.isPending) return <LoadingState variant="skeleton" rows={4} label={t('loading')} />;
  if (runs.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void runs.refetch()} />;
  }
  if (runs.data.runs.length === 0) {
    return <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />;
  }
  return (
    <Table narrow="list" data-testid="workflow-runs">
      <TableHeader>
        <TableRow>
          <TableHead>{t('columns.started')}</TableHead>
          <TableHead>{t('columns.status')}</TableHead>
          <TableHead>{t('columns.origin')}</TableHead>
          <TableHead>{t('columns.version')}</TableHead>
          <TableHead>{t('columns.spent')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.data.runs.map((run) => (
          <TableRow key={run.id} data-testid="workflow-run-row">
            <TableCell cell="title">
              <Link
                href={`/arbeitsbereich/${workspaceId}/workflows/${workflowId}/laeufe/${run.id}`}
                className="font-medium hover:underline"
              >
                {format.moment(run.createdAt)}
              </Link>
              {run.startedBy === null ? null : (
                <div className="text-xs text-muted-foreground">
                  {t('startedBy', { name: run.startedBy.name ?? '?' })}
                </div>
              )}
            </TableCell>
            <TableCell label={t('columns.status')}>
              <Badge variant={runStatusVariant(run.status)}>{wording.runStatus(run.status)}</Badge>
            </TableCell>
            <TableCell label={t('columns.origin')} className="text-sm">
              {wording.origin(run.origin)}
            </TableCell>
            <TableCell label={t('columns.version')} className="exocortex-numeric text-sm">
              {run.version}
            </TableCell>
            <TableCell label={t('columns.spent')} className="exocortex-numeric text-sm">
              {format.money(run.spentMicroUsd)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
