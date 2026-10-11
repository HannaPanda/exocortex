'use client';

import { useTranslations } from 'next-intl';

import { type WorkflowAuthor, type WorkflowSummary } from '@exocortex/contracts';
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

import { useWorkflowVersions } from '@/lib/api/workflow-queries';

import { useRunFormat } from '../runs/run-inspector-format';

/**
 * The published versions (issue #164). A version is never edited, so this
 * is the record of exactly what was reviewed and switched on, and by whom,
 * and who wrote the graph that was reviewed (issue #165).
 */
export function WorkflowVersionsTab({
  workflow,
  active,
}: {
  workflow: WorkflowSummary;
  active: boolean;
}) {
  const t = useTranslations('workflows.versions');
  const format = useRunFormat();
  const versions = useWorkflowVersions(workflow.id, active);

  if (versions.isPending) {
    return <LoadingState variant="skeleton" rows={3} label={t('loading')} />;
  }
  if (versions.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void versions.refetch()} />;
  }
  if (versions.data.versions.length === 0) {
    return <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />;
  }
  return (
    <Table narrow="list" data-testid="workflow-versions">
      <TableHeader>
        <TableRow>
          <TableHead>{t('columns.version')}</TableHead>
          <TableHead>{t('columns.published')}</TableHead>
          <TableHead>{t('columns.by')}</TableHead>
          <TableHead>{t('columns.author')}</TableHead>
          <TableHead>{t('columns.revision')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {versions.data.versions.map((version) => (
          <TableRow key={version.id}>
            <TableCell cell="title" className="exocortex-numeric">
              {t('version', { version: version.version })}
              {workflow.publishedVersion?.id === version.id ? (
                <Badge variant="secondary" className="ml-2">
                  {workflow.enabled ? t('currentEnabled') : t('current')}
                </Badge>
              ) : null}
            </TableCell>
            <TableCell label={t('columns.published')} className="text-sm">
              {format.moment(version.publishedAt)}
            </TableCell>
            <TableCell label={t('columns.by')} className="text-sm">
              {version.publishedBy?.name ?? t('unknown')}
            </TableCell>
            <TableCell label={t('columns.author')} className="text-sm">
              <AuthorName author={version.draftAuthor} />
            </TableCell>
            <TableCell label={t('columns.revision')} className="exocortex-numeric text-sm">
              {version.draftRevision}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function AuthorName({ author }: { author: WorkflowAuthor }) {
  const t = useTranslations('workflows.versions');
  const name = author.account?.name ?? t('unknown');
  if (author.kind === 'human') return <>{name}</>;
  return (
    <>
      {t('authorBy', {
        kind: author.kind,
        label: author.agentLabel ?? t('unnamedAgent'),
        name,
      })}
    </>
  );
}
