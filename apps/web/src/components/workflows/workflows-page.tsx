'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { WORKFLOW_LIMITS, type WorkflowSummary } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  AppPage,
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { useCreateWorkflow, useWorkflows } from '@/lib/api/workflow-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { Field } from './workflow-fields';
import { useWorkflowWording } from './workflow-labels';

/**
 * The workflows of a workspace (issue #164): which exist, which are switched
 * on, what starts them and whether a run is in flight.
 */
export function WorkflowsPage({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('workflows.list');
  const params = useSearchParams();
  const router = useRouter();
  const detail = useWorkspaceDetail(workspaceId);
  const workflows = useWorkflows(workspaceId);
  const role = detail.data?.role ?? null;
  const canManage = role === 'OWNER' || role === 'ADMIN';
  // `?new=1` is the palette's "Neuer Workflow"; dropped once read.
  const [creating, setCreating] = React.useState(() => params.get('new') === '1');
  React.useEffect(() => {
    if (params.get('new') === '1') router.replace(`/arbeitsbereich/${workspaceId}/workflows`);
  }, [params, router, workspaceId]);

  return (
    <AppPage maxWidth="max-w-5xl" className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="exocortex-page-title">{t('title')}</h1>
          <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        {canManage ? (
          <Button onClick={() => setCreating(true)} data-testid="workflow-new">
            {t('newWorkflow')}
          </Button>
        ) : null}
      </div>

      {workflows.isPending ? (
        <LoadingState variant="skeleton" rows={4} label={t('loading')} />
      ) : workflows.isError ? (
        <ErrorState title={t('loadFailed')} onRetry={() => void workflows.refetch()} />
      ) : workflows.data.workflows.length === 0 ? (
        <EmptyState
          title={t('emptyTitle')}
          description={canManage ? t('emptyDescription') : t('emptyDescriptionReader')}
        />
      ) : (
        <WorkflowTable workspaceId={workspaceId} workflows={workflows.data.workflows} />
      )}

      <CreateWorkflowDialog
        open={creating && canManage}
        onOpenChange={setCreating}
        workspaceId={workspaceId}
      />
    </AppPage>
  );
}

function WorkflowTable({
  workspaceId,
  workflows,
}: {
  workspaceId: string;
  workflows: readonly WorkflowSummary[];
}) {
  const t = useTranslations('workflows.list');
  const wording = useWorkflowWording();
  return (
    <Table narrow="list" data-testid="workflow-list">
      <TableHeader>
        <TableRow>
          <TableHead>{t('columns.name')}</TableHead>
          <TableHead>{t('columns.state')}</TableHead>
          <TableHead>{t('columns.triggers')}</TableHead>
          <TableHead>{t('columns.runs')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {workflows.map((workflow) => (
          <TableRow key={workflow.id} data-testid="workflow-row">
            <TableCell cell="title">
              <Link
                href={`/arbeitsbereich/${workspaceId}/workflows/${workflow.id}`}
                className="font-medium hover:underline"
              >
                {workflow.name}
              </Link>
              {workflow.description === null ? null : (
                <div className="line-clamp-1 text-xs text-muted-foreground">
                  {workflow.description}
                </div>
              )}
            </TableCell>
            <TableCell label={t('columns.state')}>
              <div className="flex flex-wrap gap-1.5">
                {workflow.enabled ? (
                  <Badge>{t('enabled')}</Badge>
                ) : (
                  <Badge variant="outline">{t('disabled')}</Badge>
                )}
                {workflow.publishedVersion === null ? (
                  <Badge variant="muted">{t('draftOnly')}</Badge>
                ) : (
                  <Badge variant="muted">
                    {t('version', { version: workflow.publishedVersion.version })}
                  </Badge>
                )}
                {workflow.hasUnpublishedChanges && workflow.publishedVersion !== null ? (
                  <Badge variant="secondary">{t('changed')}</Badge>
                ) : null}
                {workflow.draftValid ? null : <Badge variant="secondary">{t('incomplete')}</Badge>}
              </div>
            </TableCell>
            <TableCell label={t('columns.triggers')} className="text-sm">
              {workflow.triggerTypes.map((type) => wording.type(type)).join(', ') || '–'}
            </TableCell>
            <TableCell label={t('columns.runs')} className="exocortex-numeric text-sm">
              {workflow.activeRunCount > 0
                ? t('activeRuns', { count: workflow.activeRunCount })
                : '–'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CreateWorkflowDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}) {
  const t = useTranslations('workflows.create');
  const router = useRouter();
  const create = useCreateWorkflow(workspaceId);
  const [name, setName] = React.useState('');
  const submit = async (): Promise<void> => {
    const created = await create.mutateAsync({ name: name.trim() });
    onOpenChange(false);
    setName('');
    router.push(`/arbeitsbereich/${workspaceId}/workflows/${created.workflow.id}`);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id="workflow-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field id="workflow-create-name" label={t('name')}>
              <Input
                id="workflow-create-name"
                value={name}
                maxLength={WORKFLOW_LIMITS.nameMaxChars}
                autoFocus
                data-testid="workflow-create-name"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </form>
          {create.error === null ? null : (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{create.error.message}</AlertDescription>
            </Alert>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            form="workflow-create-form"
            disabled={name.trim().length === 0 || create.isPending}
            data-testid="workflow-create-submit"
          >
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
