'use client';

import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SparklesIcon,
  Trash2Icon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  WORK_ITEM_STATUSES,
  type WorkItemDetail,
  type WorkItemStatus,
  type WorkspaceMember,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  AppPage,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ErrorState,
  Input,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@exocortex/ui';

import { WorkItemAttention } from '@/components/attention/work-item-attention';
import { WorkItemChangesets } from '@/components/changesets/work-item-changesets';
import { useAiModels } from '@/lib/api/ai-queries';
import { useSessionQuery } from '@/lib/api/session-queries';
import {
  useDeleteWorkItem,
  useStartWorkItemRun,
  useUpdateWorkItem,
  useWorkItem,
} from '@/lib/api/work-item-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { WorkItemAiSettings } from './work-item-ai-settings';
import { CheckpointSection } from './work-item-checkpoint';
import { ChildrenSection } from './work-item-children';
import { WorkItemDialog } from './work-item-dialog';
import { statusVariant, useWorkItemWording } from './work-item-labels';
import { BriefSection, HistorySection, ResultSection, RunsSection } from './work-item-sections';

/**
 * One piece of delegated work (issue #138, ADR-066).
 *
 * Who may do what mirrors the API: a MEMBER edits everything, the assignee
 * may move the work along whatever their role, and deleting is for the
 * requester and the workspace's admins. The buttons for the rest are simply
 * not drawn, rather than drawn and refused.
 */
export function WorkItemDetailPage({
  workspaceId,
  workItemId,
}: {
  workspaceId: string;
  workItemId: string;
}) {
  const t = useTranslations('workItems.detail');
  const query = useWorkItem(workItemId);
  const workspace = useWorkspaceDetail(workspaceId);
  const session = useSessionQuery();

  if (query.isPending) return <LoadingState variant="skeleton" rows={6} label={t('loading')} />;
  if (query.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void query.refetch()} />;
  }

  const item = query.data.workItem;
  const userId = session.data?.user?.id ?? null;
  const role = workspace.data?.role ?? null;
  const canWrite = role !== null && role !== 'GUEST';
  const isAssignee = userId !== null && item.assignee?.userId === userId;

  return (
    <WorkItemView
      item={item}
      members={workspace.data?.members ?? []}
      canWrite={canWrite}
      canProgress={canWrite || isAssignee}
      canDelete={
        role === 'OWNER' || role === 'ADMIN' || (canWrite && item.requester.userId === userId)
      }
    />
  );
}

function WorkItemView({
  item,
  members,
  canWrite,
  canProgress,
  canDelete,
}: {
  item: WorkItemDetail;
  members: readonly WorkspaceMember[];
  canWrite: boolean;
  canProgress: boolean;
  canDelete: boolean;
}) {
  const t = useTranslations('workItems.detail');
  const [editing, setEditing] = React.useState(false);
  const [addingChild, setAddingChild] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const closed = item.closedAt !== null;
  const canStart = canWrite && !closed;

  return (
    <AppPage maxWidth="max-w-3xl" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <Link
          href={
            item.parent === null
              ? `/arbeitsbereich/${item.workspaceId}/auftraege`
              : `/arbeitsbereich/${item.workspaceId}/auftraege/${item.parent.id}`
          }
          className="flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {item.parent === null
              ? t('backToList')
              : t('backToParent', { title: item.parent.title })}
          </span>
        </Link>

        {/* The title takes the row; the actions wrap under it when the column
            is narrow, instead of squeezing the title into one word per line. */}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <h1
            className="exocortex-page-title min-w-[min(100%,18rem)] flex-1 break-words hyphens-auto"
            data-testid="work-item-title-heading"
          >
            {item.title}
          </h1>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {canStart ? (
              <Button size="sm" onClick={() => setStarting(true)} data-testid="work-item-start-run">
                <SparklesIcon />
                {t('startRun')}
              </Button>
            ) : null}
            {canWrite ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(true)}
                data-testid="work-item-edit"
              >
                <PencilIcon />
                {t('edit')}
              </Button>
            ) : null}
            {canDelete ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-sm"
                      className="size-8"
                      aria-label={t('moreActions')}
                      data-testid="work-item-more"
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setDeleting(true)}
                    data-testid="work-item-delete"
                  >
                    <Trash2Icon />
                    {t('delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>

        <StatusLine item={item} disabled={!canProgress} />

        {item.statusReason === null ? null : (
          <p className="text-sm text-muted-foreground" data-testid="work-item-status-reason">
            {item.statusReason}
          </p>
        )}
      </header>

      <WorkItemAttention workItemId={item.id} />
      <BriefSection item={item} canProgress={canProgress} />
      <ResultSection item={item} canProgress={canProgress} />
      <WorkItemChangesets item={item} />
      <ChildrenSection item={item} onAddChild={canWrite ? () => setAddingChild(true) : null} />
      <RunsSection item={item} />
      <CheckpointSection item={item} />
      <WorkItemAiSettings item={item} canWrite={canWrite} />
      <HistorySection item={item} canProgress={canProgress} />

      {canWrite ? (
        <>
          <WorkItemDialog
            open={editing}
            onOpenChange={setEditing}
            workspaceId={item.workspaceId}
            members={members}
            item={item}
          />
          <WorkItemDialog
            open={addingChild}
            onOpenChange={setAddingChild}
            workspaceId={item.workspaceId}
            members={members}
            item={null}
            parentId={item.id}
          />
          <StartRunDialog item={item} open={starting} onOpenChange={setStarting} />
        </>
      ) : null}
      {canDelete ? <DeleteDialog item={item} open={deleting} onOpenChange={setDeleting} /> : null}
    </AppPage>
  );
}

/** Status, priority, who handed the work to whom, and when it is due. */
function StatusLine({ item, disabled }: { item: WorkItemDetail; disabled: boolean }) {
  const t = useTranslations('workItems.detail');
  const wording = useWorkItemWording();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
      <StatusMenu item={item} disabled={disabled} />
      {item.priority === 'normal' ? null : (
        <Badge variant="outline">{wording.priority(item.priority)}</Badge>
      )}
      <span>
        {t('handover', {
          requester: wording.participant(item.requester),
          assignee: wording.participant(item.assignee),
        })}
      </span>
      {item.dueAt === null ? null : (
        <span className="exocortex-numeric">{t('due', { day: wording.day(item.dueAt) })}</span>
      )}
    </div>
  );
}

/** The statuses that need a word on why, and ask for it before they are set. */
const REASON_STATUSES: readonly WorkItemStatus[] = ['blocked', 'waiting_for_human', 'failed'];

/**
 * The status is the control (issue #182): the badge opens the list, and a
 * choice applies at once. A status that needs a reason asks for it in a field
 * under the header first, so nothing is set half-explained.
 */
function StatusMenu({ item, disabled }: { item: WorkItemDetail; disabled: boolean }) {
  const t = useTranslations('workItems.detail');
  const wording = useWorkItemWording();
  const update = useUpdateWorkItem(item.workspaceId);
  const [asking, setAsking] = React.useState<WorkItemStatus | null>(null);
  const [reason, setReason] = React.useState('');

  const apply = (status: WorkItemStatus, statusReason: string | null): void => {
    update.mutate(
      { workItemId: item.id, request: { status, statusReason } },
      { onSuccess: () => setAsking(null) },
    );
  };
  const choose = (status: WorkItemStatus): void => {
    update.reset();
    if (REASON_STATUSES.includes(status)) {
      setReason(status === item.status ? (item.statusReason ?? '') : '');
      setAsking(status);
      return;
    }
    setAsking(null);
    if (status !== item.status) apply(status, null);
  };
  const confirm = (): void => {
    if (asking === null) return;
    const trimmed = reason.trim();
    apply(asking, trimmed.length > 0 ? trimmed : null);
  };

  const badge = (
    <Badge variant={statusVariant(item.status)} data-testid="work-item-status-badge">
      {wording.status(item.status)}
    </Badge>
  );

  return (
    <>
      {disabled ? (
        badge
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="inline-flex min-h-8 items-center gap-1 rounded-md px-1 -mx-1 text-foreground transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none"
                aria-label={t('statusMenuLabel', { status: wording.status(item.status) })}
                data-testid="work-item-status"
              >
                {badge}
                <ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden />
              </button>
            }
          />
          <DropdownMenuContent align="start">
            {WORK_ITEM_STATUSES.map((value) => (
              <DropdownMenuItem
                key={value}
                onClick={() => choose(value)}
                disabled={update.isPending}
                data-testid={`work-item-status-${value}`}
              >
                <CheckIcon
                  className={value === item.status ? undefined : 'invisible'}
                  aria-hidden
                />
                {wording.status(value)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {asking === null ? null : (
        <form
          className="flex w-full flex-wrap items-end gap-2 pt-1"
          onSubmit={(event) => {
            event.preventDefault();
            confirm();
          }}
          data-testid="work-item-reason-form"
        >
          <div className="flex min-w-[min(100%,16rem)] flex-1 flex-col gap-1.5">
            <Label htmlFor="work-item-reason" className="text-foreground">
              {t('reasonLabelFor', { status: wording.status(asking) })}
            </Label>
            <Input
              id="work-item-reason"
              value={reason}
              maxLength={1000}
              autoFocus
              placeholder={t('reasonPlaceholder')}
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setAsking(null);
                }
              }}
              data-testid="work-item-reason"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            className="h-9"
            disabled={update.isPending}
            data-testid="work-item-status-save"
          >
            {t('setStatus')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-9"
            onClick={() => setAsking(null)}
          >
            {t('cancelEdit')}
          </Button>
        </form>
      )}
      {update.error === null ? null : (
        <p className="w-full text-sm text-destructive-text" role="alert">
          {update.error.message}
        </p>
      )}
    </>
  );
}

function StartRunDialog({
  item,
  open,
  onOpenChange,
}: {
  item: WorkItemDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('workItems.startRun');
  const tProfile = useTranslations('agentProfiles.workItem');
  const wording = useWorkItemWording();
  const start = useStartWorkItemRun(item.workspaceId);
  const [instructions, setInstructions] = React.useState('');
  const [fromCheckpoint, setFromCheckpoint] = React.useState(true);
  const [modelSlug, setModelSlug] = React.useState<string | null>(null);
  const resumable = item.latestCheckpointAt !== null;

  const submit = async (): Promise<void> => {
    const text = instructions.trim();
    await start.mutateAsync({
      workItemId: item.id,
      request: {
        ...(text.length === 0 ? {} : { instructions: text }),
        ...(modelSlug === null ? {} : { modelSlug }),
        ...(resumable && !fromCheckpoint ? { fromCheckpoint: 'none' as const } : {}),
      },
    });
    setInstructions('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-3">
            {start.error === null ? null : (
              <Alert variant="destructive">
                <AlertDescription>{start.error.message}</AlertDescription>
              </Alert>
            )}
            {item.latestCheckpointAt === null ? null : (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="work-item-from-checkpoint"
                  checked={fromCheckpoint}
                  onCheckedChange={(checked) => setFromCheckpoint(checked === true)}
                  data-testid="work-item-from-checkpoint"
                />
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor="work-item-from-checkpoint">
                    {t('fromCheckpoint', { moment: wording.moment(item.latestCheckpointAt) })}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t('fromCheckpointHint')}</p>
                </div>
              </div>
            )}
            {item.agentProfile === null ? null : (
              <p className="text-xs text-muted-foreground" data-testid="work-item-run-profile">
                {tProfile('runsUnder', { name: item.agentProfile.name })}
              </p>
            )}
            <RunModelSelect value={modelSlug} onChange={setModelSlug} />
            <Label htmlFor="work-item-instructions">{t('instructionsLabel')}</Label>
            <Textarea
              id="work-item-instructions"
              value={instructions}
              rows={3}
              placeholder={t('instructionsPlaceholder')}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={start.isPending}
            data-testid="work-item-start-run-confirm"
          >
            {t('start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Which model the attempt uses (issue #142): a run carried on from a working
 * state may well be another model than the one that began the work, because
 * the provider it used is out of quota or simply because somebody chose.
 */
function RunModelSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const t = useTranslations('workItems.startRun');
  const models = useAiModels();
  const usable = (models.data?.models ?? []).filter((model) => model.supportsTools);
  if (usable.length === 0) return null;
  const DEFAULT = '__default__';
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="work-item-run-model">{t('modelLabel')}</Label>
      <Select
        value={value ?? DEFAULT}
        onValueChange={(next) => onChange(next === DEFAULT || next === null ? null : next)}
      >
        <SelectTrigger id="work-item-run-model" data-testid="work-item-run-model">
          <SelectValue>
            {() =>
              value === null
                ? t('modelDefault')
                : (usable.find((model) => model.slug === value)?.displayName ?? value)
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT}>{t('modelDefault')}</SelectItem>
          {usable.map((model) => (
            <SelectItem key={model.slug} value={model.slug}>
              {model.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function DeleteDialog({
  item,
  open,
  onOpenChange,
}: {
  item: WorkItemDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('workItems.deleteDialog');
  const router = useRouter();
  const remove = useDeleteWorkItem(item.workspaceId);

  const confirm = async (): Promise<void> => {
    await remove.mutateAsync(item.id);
    onOpenChange(false);
    router.push(`/arbeitsbereich/${item.workspaceId}/auftraege`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void confirm()}
            disabled={remove.isPending}
            data-testid="work-item-delete-confirm"
          >
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
