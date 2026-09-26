'use client';

import { ArrowLeftIcon } from 'lucide-react';
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
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { useSessionQuery } from '@/lib/api/session-queries';
import {
  useDeleteWorkItem,
  useStartWorkItemRun,
  useUpdateWorkItem,
  useWorkItem,
} from '@/lib/api/work-item-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { WorkItemDialog } from './work-item-dialog';
import { statusVariant, useWorkItemWording } from './work-item-labels';
import {
  ChildrenSection,
  ContextSection,
  CriteriaSection,
  HistorySection,
  ResultSection,
  RunsSection,
} from './work-item-sections';

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
  const wording = useWorkItemWording();
  const [editing, setEditing] = React.useState(false);
  const [addingChild, setAddingChild] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const closed = item.closedAt !== null;

  return (
    <AppPage maxWidth="max-w-3xl" className="flex flex-col gap-5">
      <Link
        href={
          item.parent === null
            ? `/arbeitsbereich/${item.workspaceId}/auftraege`
            : `/arbeitsbereich/${item.workspaceId}/auftraege/${item.parent.id}`
        }
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {item.parent === null ? t('backToList') : t('backToParent', { title: item.parent.title })}
      </Link>

      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-4">
          <h1 className="exocortex-page-title" data-testid="work-item-title-heading">
            {item.title}
          </h1>
          <div className="flex shrink-0 gap-2">
            {canWrite ? (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                {t('edit')}
              </Button>
            ) : null}
            {canDelete ? (
              <Button variant="ghost" size="sm" onClick={() => setDeleting(true)}>
                {t('delete')}
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant={statusVariant(item.status)}>{wording.status(item.status)}</Badge>
          {item.priority === 'normal' ? null : (
            <Badge variant="outline">{wording.priority(item.priority)}</Badge>
          )}
          <span>
            {t('handover', {
              requester: wording.participant(item.requester),
              assignee: wording.participant(item.assignee),
            })}
          </span>
          {item.dueAt === null ? null : <span>{t('due', { day: wording.day(item.dueAt) })}</span>}
        </div>
      </div>

      <WorkItemAttention workItemId={item.id} />

      <StatusControl item={item} disabled={!canProgress} />

      <p className="text-sm whitespace-pre-wrap" data-testid="work-item-goal-text">
        {item.goal}
      </p>

      <CriteriaSection item={item} canProgress={canProgress} />
      <ContextSection item={item} />
      <ResultSection item={item} canProgress={canProgress} />
      <RunsSection
        item={item}
        action={
          canWrite && !closed ? (
            <Button size="sm" onClick={() => setStarting(true)} data-testid="work-item-start-run">
              {t('startRun')}
            </Button>
          ) : null
        }
      />
      <ChildrenSection item={item} onAddChild={canWrite ? () => setAddingChild(true) : null} />
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

/** The statuses that need a word on why, and get a field for it. */
const REASON_STATUSES: readonly WorkItemStatus[] = ['blocked', 'waiting_for_human', 'failed'];

function StatusControl({ item, disabled }: { item: WorkItemDetail; disabled: boolean }) {
  const t = useTranslations('workItems.detail');
  const wording = useWorkItemWording();
  const update = useUpdateWorkItem(item.workspaceId);
  const [status, setStatus] = React.useState<WorkItemStatus>(item.status);
  const [reason, setReason] = React.useState(item.statusReason ?? '');
  const [shownFor, setShownFor] = React.useState(`${item.status}:${item.statusReason ?? ''}`);
  const stored = `${item.status}:${item.statusReason ?? ''}`;
  if (stored !== shownFor) {
    setShownFor(stored);
    setStatus(item.status);
    setReason(item.statusReason ?? '');
  }

  const needsReason = REASON_STATUSES.includes(status);
  const dirty =
    status !== item.status || (needsReason && reason.trim() !== (item.statusReason ?? ''));

  const save = (): void => {
    const trimmed = reason.trim();
    update.mutate({
      workItemId: item.id,
      request: {
        status,
        statusReason: needsReason && trimmed.length > 0 ? trimmed : null,
      },
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="work-item-status">{t('statusLabel')}</Label>
          <Select
            value={status}
            onValueChange={(value) => setStatus(value as WorkItemStatus)}
            disabled={disabled}
          >
            <SelectTrigger id="work-item-status" className="w-56" data-testid="work-item-status">
              <SelectValue>{() => wording.status(status)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {WORK_ITEM_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {wording.status(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {needsReason ? (
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="work-item-reason">{t('reasonLabel')}</Label>
            <Input
              id="work-item-reason"
              value={reason}
              maxLength={1000}
              placeholder={t('reasonPlaceholder')}
              onChange={(event) => setReason(event.target.value)}
              disabled={disabled}
            />
          </div>
        ) : null}
        <Button
          size="sm"
          onClick={save}
          disabled={disabled || !dirty || update.isPending}
          data-testid="work-item-status-save"
        >
          {t('setStatus')}
        </Button>
      </div>
      {!needsReason && item.statusReason !== null ? (
        <p className="text-sm text-muted-foreground">{item.statusReason}</p>
      ) : null}
      {update.error === null ? null : (
        <p className="text-sm text-destructive-text">{update.error.message}</p>
      )}
    </div>
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
  const start = useStartWorkItemRun(item.workspaceId);
  const [instructions, setInstructions] = React.useState('');

  const submit = async (): Promise<void> => {
    const text = instructions.trim();
    await start.mutateAsync({
      workItemId: item.id,
      request: text.length === 0 ? {} : { instructions: text },
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
