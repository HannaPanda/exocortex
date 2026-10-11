'use client';

import { FlaskConicalIcon, MoreHorizontalIcon, SaveIcon, UploadIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AgentProfile,
  type WorkflowProblem,
  type WorkflowResponse,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Switch,
} from '@exocortex/ui';

import {
  useDeleteWorkflow,
  useDuplicateWorkflow,
  usePublishWorkflow,
} from '@/lib/api/workflow-queries';

import { WorkflowActivationDialog } from './workflow-activation-dialog';
import { WorkflowTestRunDialog } from './workflow-test-run-dialog';

/**
 * The editor's title row (issue #164): the workflow's name and state, and
 * the decisions that are made about the whole of it: save the draft, publish
 * it as a version, try that version, switch it on.
 *
 * Each of those is a separate step on purpose, and each says why it cannot
 * be taken yet: a draft with problems cannot be published, an unsaved one
 * cannot either, only a published workflow can be tried or switched on, and
 * only the owner may switch one on. A draft an agent wrote says so
 * (`AgentDraftNotice`, issue #165).
 */
export function WorkflowEditorHeader({
  workspaceId,
  response,
  name,
  dirty,
  savable,
  saving,
  problems,
  canManage,
  canActivate,
  profiles,
  onSave,
  onOpenRuns,
}: {
  workspaceId: string;
  response: WorkflowResponse;
  name: string;
  dirty: boolean;
  savable: boolean;
  saving: boolean;
  problems: readonly WorkflowProblem[];
  canManage: boolean;
  canActivate: boolean;
  profiles: readonly AgentProfile[];
  onSave: () => void;
  onOpenRuns: () => void;
}) {
  const t = useTranslations('workflows.header');
  const { workflow } = response;
  const publish = usePublishWorkflow(workspaceId, workflow.id);
  const [activating, setActivating] = React.useState<boolean | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const blocker = publishBlocker(t, { dirty, problems: problems.length, workflow });
  const published = workflow.publishedVersion;
  const router = useRouter();
  const duplicate = useDuplicateWorkflow(workspaceId, workflow.id);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="exocortex-page-title truncate">{name.trim() || workflow.name}</h1>
          <StateLine response={response} dirty={dirty} onOpenRuns={onOpenRuns} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ActivationSwitch
            enabled={workflow.enabled}
            published={published !== null}
            canActivate={canActivate}
            onChange={setActivating}
          />
          {canManage ? (
            <>
              <Button
                variant="outline"
                onClick={onSave}
                disabled={!dirty || !savable || saving}
                data-testid="workflow-save"
              >
                <SaveIcon className="size-4" />
                {saving ? t('saving') : t('save')}
              </Button>
              <Button
                variant="outline"
                disabled={blocker !== null || publish.isPending}
                title={blocker ?? undefined}
                onClick={() => publish.mutate(workflow.draftRevision)}
                data-testid="workflow-publish"
              >
                <UploadIcon className="size-4" />
                {t('publish')}
              </Button>
              <Button
                onClick={() => setTesting(true)}
                disabled={published === null}
                title={published === null ? t('testNeedsVersion') : undefined}
                data-testid="workflow-test-run"
              >
                <FlaskConicalIcon className="size-4" />
                {t('testRun')}
              </Button>
              <MoreMenu
                deletable={workflow.activeRunCount === 0}
                onDelete={() => setDeleting(true)}
                onDuplicate={() =>
                  duplicate.mutate(undefined, {
                    onSuccess: (copy) =>
                      router.push(`/arbeitsbereich/${workspaceId}/workflows/${copy.workflow.id}`),
                  })
                }
              />
            </>
          ) : null}
        </div>
      </div>

      <AgentDraftNotice workflow={workflow} />
      <ErrorAlert error={duplicate.error} />
      {blocker !== null && canManage && (dirty || problems.length > 0) ? (
        <p className="text-xs text-muted-foreground" data-testid="workflow-publish-blocker">
          {blocker}
        </p>
      ) : null}
      {publish.isSuccess && !workflow.hasUnpublishedChanges && published !== null ? (
        <p className="text-xs text-muted-foreground" role="status">
          {t('publishedNow', { version: published.version })}
        </p>
      ) : null}
      <ErrorAlert error={publish.error} />
      {response.envelope.workflowsEnabled ? null : (
        <Alert data-testid="workflow-switched-off">
          <AlertDescription>{t('workflowsOff')}</AlertDescription>
        </Alert>
      )}

      <WorkflowActivationDialog
        open={activating !== null}
        enable={activating === true}
        onOpenChange={(open) => {
          if (!open) setActivating(null);
        }}
        workspaceId={workspaceId}
        response={response}
        profiles={profiles}
      />
      <WorkflowTestRunDialog
        open={testing}
        onOpenChange={setTesting}
        workspaceId={workspaceId}
        response={response}
      />
      <DeleteWorkflowDialog
        open={deleting}
        onOpenChange={setDeleting}
        workspaceId={workspaceId}
        workflowId={workflow.id}
        name={workflow.name}
      />
    </div>
  );
}

/** Why the draft cannot be published yet, or null when it can. */
function publishBlocker(
  t: ReturnType<typeof useTranslations<'workflows.header'>>,
  input: { dirty: boolean; problems: number; workflow: WorkflowResponse['workflow'] },
): string | null {
  if (input.dirty) return t('publishBlockedUnsaved');
  if (input.problems > 0) return t('publishBlockedProblems', { count: input.problems });
  if (!input.workflow.hasUnpublishedChanges) return t('publishBlockedUnchanged');
  return null;
}

/**
 * Says above everything else that an agent or the assistant wrote the draft
 * (issue #165), until it is published: the person pressing publish is the
 * review, and publishing takes exactly the revision named here.
 */
function AgentDraftNotice({ workflow }: { workflow: WorkflowResponse['workflow'] }) {
  const t = useTranslations('workflows.header');
  const author = workflow.draftAuthor;
  if (author.kind === 'human' || !workflow.hasUnpublishedChanges) return null;
  return (
    <Alert data-testid="workflow-agent-draft">
      <AlertDescription>
        {t('agentDraft', {
          kind: author.kind,
          label: author.agentLabel ?? t('unnamedAgent'),
          revision: workflow.draftRevision,
        })}
      </AlertDescription>
    </Alert>
  );
}

function ErrorAlert({ error }: { error: Error | null }) {
  if (error === null) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}

function StateLine({
  response,
  dirty,
  onOpenRuns,
}: {
  response: WorkflowResponse;
  dirty: boolean;
  onOpenRuns: () => void;
}) {
  const t = useTranslations('workflows.header');
  const { workflow } = response;
  const published = workflow.publishedVersion;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" data-testid="workflow-state">
      {dirty ? (
        <Badge variant="secondary">{t('unsaved')}</Badge>
      ) : (
        <Badge variant="muted">{t('saved', { revision: workflow.draftRevision })}</Badge>
      )}
      {published === null ? (
        <Badge variant="outline">{t('neverPublished')}</Badge>
      ) : (
        <Badge variant="outline" data-testid="workflow-published-version">
          {t('publishedVersion', { version: published.version })}
        </Badge>
      )}
      {published !== null && workflow.hasUnpublishedChanges ? (
        <span className="text-muted-foreground">{t('draftAhead')}</span>
      ) : null}
      {workflow.activeRunCount > 0 ? (
        <button type="button" className="text-primary-text hover:underline" onClick={onOpenRuns}>
          {t('activeRuns', { count: workflow.activeRunCount })}
        </button>
      ) : null}
    </div>
  );
}

function MoreMenu({
  deletable,
  onDelete,
  onDuplicate,
}: {
  deletable: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const t = useTranslations('workflows.header');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label={t('more')}>
            <MoreHorizontalIcon className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onDuplicate} data-testid="workflow-duplicate">
          {t('duplicate')}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={onDelete} disabled={!deletable}>
          {t('delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeleteWorkflowDialog({
  open,
  onOpenChange,
  workspaceId,
  workflowId,
  name,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workflowId: string;
  name: string;
}) {
  const t = useTranslations('workflows.header');
  const router = useRouter();
  const remove = useDeleteWorkflow(workspaceId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('deleteTitle', { name })}</DialogTitle>
          <DialogDescription>{t('deleteDescription')}</DialogDescription>
        </DialogHeader>
        {remove.error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{remove.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            data-testid="workflow-delete-confirm"
            onClick={() =>
              remove.mutate(workflowId, {
                onSuccess: () => router.push(`/arbeitsbereich/${workspaceId}/workflows`),
              })
            }
          >
            {t('deleteConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActivationSwitch({
  enabled,
  published,
  canActivate,
  onChange,
}: {
  enabled: boolean;
  published: boolean;
  canActivate: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const t = useTranslations('workflows.header');
  const hint = !canActivate
    ? t('activateOwnerOnly')
    : published
      ? undefined
      : t('activateNeedsVersion');
  return (
    <label className="flex items-center gap-2 text-sm" title={hint}>
      <Switch
        checked={enabled}
        disabled={!canActivate || (!published && !enabled)}
        onCheckedChange={(checked) => onChange(checked === true)}
        data-testid="workflow-enabled"
      />
      {enabled ? t('enabled') : t('disabled')}
    </label>
  );
}
