'use client';

import {
  ArrowLeftIcon,
  FlaskConicalIcon,
  MoreHorizontalIcon,
  SaveIcon,
  UploadIcon,
} from 'lucide-react';
import Link from 'next/link';
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import {
  useDeleteWorkflow,
  useDuplicateWorkflow,
  usePublishWorkflow,
} from '@/lib/api/workflow-queries';

import { WorkflowActivationDialog } from './workflow-activation-dialog';
import { WorkflowTestRunDialog } from './workflow-test-run-dialog';

/**
 * The editor's head (issues #164, #198): the workflow's name and state, and
 * the decisions made about the whole of it -- save the draft, publish it as
 * a version, try that version, switch it on.
 *
 * Each is a separate step on purpose, and each says why it cannot be taken
 * yet, in text a keyboard and a screen reader reach rather than a tooltip:
 * a draft with problems cannot be published, an unsaved one cannot either,
 * only a published workflow can be tried or switched on, and only the owner
 * may switch one on. Of the three buttons exactly one is filled, the one
 * that is the next step from here (save, then publish, then try), so the
 * head answers "what now" without being read twice. A draft an agent wrote
 * says so (`AgentDraftNotice`, issue #165).
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
  tabs,
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
  /** The tab list (Entwurf, Läufe, Versionen), drawn in the head's second row. */
  tabs: React.ReactNode;
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
  const ids = React.useId();
  const showBlocker = blocker !== null && canManage && (dirty || problems.length > 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <HeaderTitle workspaceId={workspaceId} name={name.trim() || workflow.name} />
        <div className="flex flex-wrap items-center gap-2">
          {canManage ? (
            <>
              <StepButtons
                next={nextStep({ dirty, savable, blocker, published: published !== null })}
                canSave={dirty && savable && !saving}
                saving={saving}
                onSave={onSave}
                blocker={blocker}
                blockerId={`${ids}-blocker`}
                publishing={publish.isPending}
                onPublish={() => publish.mutate(workflow.draftRevision)}
                published={published !== null}
                onTest={() => setTesting(true)}
              />
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

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {tabs}
        <StateLine
          response={response}
          dirty={dirty}
          onOpenRuns={onOpenRuns}
          activation={
            <ActivationSwitch
              enabled={workflow.enabled}
              published={published !== null}
              canActivate={canActivate}
              onChange={setActivating}
            />
          }
        />
      </div>

      <p
        id={`${ids}-blocker`}
        className={showBlocker ? 'text-meta text-muted-foreground' : 'exocortex-sr-only'}
        data-testid={showBlocker ? 'workflow-publish-blocker' : undefined}
      >
        {blocker ?? ''}
      </p>
      <p role="status" className="text-meta text-muted-foreground empty:hidden">
        {publish.isSuccess && !workflow.hasUnpublishedChanges && published !== null
          ? t('publishedNow', { version: published.version })
          : ''}
      </p>
      <AgentDraftNotice workflow={workflow} />
      <ErrorAlert error={duplicate.error} />
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

function HeaderTitle({ workspaceId, name }: { workspaceId: string; name: string }) {
  const t = useTranslations('workflows.header');
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('back')}
              render={<Link href={`/arbeitsbereich/${workspaceId}/workflows`} />}
              data-testid="workflow-back"
            >
              <ArrowLeftIcon />
            </Button>
          }
        />
        <TooltipContent>{t('back')}</TooltipContent>
      </Tooltip>
      <h1 className="exocortex-page-title min-w-0 truncate" title={name}>
        {name}
      </h1>
    </div>
  );
}

/** Save, publish, try: the three steps, with the next one filled. */
function StepButtons({
  next,
  canSave,
  saving,
  onSave,
  blocker,
  blockerId,
  publishing,
  onPublish,
  published,
  onTest,
}: {
  next: 'save' | 'publish' | 'test' | null;
  canSave: boolean;
  saving: boolean;
  onSave: () => void;
  blocker: string | null;
  blockerId: string;
  publishing: boolean;
  onPublish: () => void;
  published: boolean;
  onTest: () => void;
}) {
  const t = useTranslations('workflows.header');
  const testHint = React.useId();
  return (
    <>
      <Button
        variant={next === 'save' ? 'default' : 'outline'}
        onClick={onSave}
        disabled={!canSave}
        aria-keyshortcuts="Control+S"
        data-testid="workflow-save"
      >
        <SaveIcon className="size-4" />
        {saving ? t('saving') : t('save')}
      </Button>
      <Button
        variant={next === 'publish' ? 'default' : 'outline'}
        disabled={blocker !== null || publishing}
        aria-describedby={blocker === null ? undefined : blockerId}
        onClick={onPublish}
        data-testid="workflow-publish"
      >
        <UploadIcon className="size-4" />
        {t('publish')}
      </Button>
      <Button
        variant={next === 'test' ? 'default' : 'outline'}
        onClick={onTest}
        disabled={!published}
        aria-describedby={published ? undefined : testHint}
        data-testid="workflow-test-run"
      >
        <FlaskConicalIcon className="size-4" />
        {t('testRun')}
      </Button>
      <span id={testHint} className="exocortex-sr-only">
        {published ? '' : t('testNeedsVersion')}
      </span>
    </>
  );
}

/**
 * The one step that moves this workflow forward from where it stands: an
 * unsaved draft is saved first, a saved one with something new is
 * published, a published one is tried. Null while problems block the way,
 * because then the next step is on the canvas, not in the head.
 */
function nextStep(input: {
  dirty: boolean;
  savable: boolean;
  blocker: string | null;
  published: boolean;
}): 'save' | 'publish' | 'test' | null {
  if (input.dirty) return input.savable ? 'save' : null;
  if (input.blocker === null) return 'publish';
  return input.published ? 'test' : null;
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
  activation,
}: {
  response: WorkflowResponse;
  dirty: boolean;
  onOpenRuns: () => void;
  activation: React.ReactNode;
}) {
  const t = useTranslations('workflows.header');
  const { workflow } = response;
  const published = workflow.publishedVersion;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs"
      data-testid="workflow-state"
    >
      {dirty ? (
        <Badge variant="secondary">{t('unsaved')}</Badge>
      ) : (
        <Badge variant="muted">{t('saved', { revision: workflow.draftRevision })}</Badge>
      )}
      {published === null ? (
        <Badge variant="outline">{t('neverPublished')}</Badge>
      ) : (
        <Badge
          variant="outline"
          data-testid="workflow-published-version"
          title={workflow.hasUnpublishedChanges ? t('draftAhead') : undefined}
        >
          {t('publishedVersion', { version: published.version })}
          {workflow.hasUnpublishedChanges ? (
            <span className="text-muted-foreground"> · {t('draftAheadShort')}</span>
          ) : null}
        </Badge>
      )}
      {activation}
      {workflow.activeRunCount > 0 ? (
        <button
          type="button"
          className="inline-flex min-h-6 items-center text-primary-text hover:underline"
          onClick={onOpenRuns}
        >
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
          <span className="flex flex-col">
            {t('delete')}
            {deletable ? null : (
              <span className="text-meta text-muted-foreground">{t('deleteBlockedRuns')}</span>
            )}
          </span>
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
  const id = React.useId();
  const hint = !canActivate
    ? t('activateOwnerOnly')
    : published
      ? undefined
      : t('activateNeedsVersion');
  return (
    <label className="flex items-center gap-2 text-xs" title={hint}>
      <Switch
        checked={enabled}
        disabled={!canActivate || (!published && !enabled)}
        onCheckedChange={(checked) => onChange(checked === true)}
        aria-describedby={hint === undefined ? undefined : id}
        data-testid="workflow-enabled"
      />
      {enabled ? t('enabled') : t('disabled')}
      <span id={id} className="exocortex-sr-only">
        {hint ?? ''}
      </span>
    </label>
  );
}
