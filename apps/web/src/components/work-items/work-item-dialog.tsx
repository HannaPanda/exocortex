'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  WORK_ITEM_PRIORITIES,
  type WorkItemAssigneeInput,
  type WorkItemCriterion,
  type WorkItemDetail,
  type WorkItemPriority,
  type WorkspaceMember,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  DatePicker,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@exocortex/ui';

import { useCreateWorkItem, useUpdateWorkItem } from '@/lib/api/work-item-queries';

import { WorkItemAssigneeSelect } from './work-item-assignee-select';
import { useWorkItemWording } from './work-item-labels';

/**
 * Handing work over, or changing what was handed over (issue #138).
 *
 * The criteria are one per line, because that is how people write a list
 * they have not thought about as a list yet; a line that was met before keeps
 * its tick when the text is unchanged. The budget is entered in dollars and
 * stored in millionths, the unit every cost here is counted in.
 */

interface Draft {
  title: string;
  goal: string;
  priority: WorkItemPriority;
  assignee: WorkItemAssigneeInput | null;
  criteria: string;
  dueDate: string | null;
  budgetUsd: string;
}

function assigneeInputOf(item: WorkItemDetail): WorkItemAssigneeInput | null {
  const assignee = item.assignee;
  if (assignee === null) return null;
  if (assignee.kind === 'assistant') return { kind: 'assistant' };
  if (assignee.userId === null) return null;
  return { kind: assignee.kind, userId: assignee.userId };
}

function draftOf(item: WorkItemDetail | null): Draft {
  if (item === null) {
    return {
      title: '',
      goal: '',
      priority: 'normal',
      assignee: null,
      criteria: '',
      dueDate: null,
      budgetUsd: '',
    };
  }
  return {
    title: item.title,
    goal: item.goal,
    priority: item.priority,
    assignee: assigneeInputOf(item),
    criteria: item.acceptanceCriteria.map((criterion) => criterion.text).join('\n'),
    dueDate: item.dueAt?.slice(0, 10) ?? null,
    budgetUsd: item.budgetMicroUsd === null ? '' : String(item.budgetMicroUsd / 1_000_000),
  };
}

function criteriaOf(text: string, previous: readonly WorkItemCriterion[]): WorkItemCriterion[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({
      text: line,
      met: previous.find((criterion) => criterion.text === line)?.met ?? false,
    }));
}

function budgetOf(text: string): number | null {
  const normalized = text.trim().replace(',', '.');
  if (normalized.length === 0) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000_000) : null;
}

export function WorkItemDialog({
  open,
  onOpenChange,
  workspaceId,
  members,
  item,
  parentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  members: readonly WorkspaceMember[];
  /** The item being edited; null creates one. */
  item: WorkItemDetail | null;
  /** For a new item: the item it becomes part of. */
  parentId?: string | null;
}) {
  const t = useTranslations('workItems.dialog');
  const wording = useWorkItemWording();
  const router = useRouter();
  const create = useCreateWorkItem(workspaceId);
  const update = useUpdateWorkItem(workspaceId);
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(item));

  // A dialog reopened for another item, or for a new one, starts from that
  // one; adjusted while rendering rather than in an effect, so no frame shows
  // the previous item's text.
  const [openedFor, setOpenedFor] = React.useState<string | null>(null);
  const key = open ? (item?.id ?? 'new') : null;
  if (key !== openedFor) {
    setOpenedFor(key);
    if (key !== null) setDraft(draftOf(item));
  }

  const set = <TKey extends keyof Draft>(field: TKey, value: Draft[TKey]): void =>
    setDraft((current) => ({ ...current, [field]: value }));

  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const valid = draft.title.trim().length > 0 && draft.goal.trim().length > 0;

  const submit = async (): Promise<void> => {
    const common = {
      title: draft.title.trim(),
      goal: draft.goal.trim(),
      priority: draft.priority,
      assignee: draft.assignee,
      acceptanceCriteria: criteriaOf(draft.criteria, item?.acceptanceCriteria ?? []),
      dueAt: draft.dueDate === null ? null : `${draft.dueDate}T00:00:00.000Z`,
      budgetMicroUsd: budgetOf(draft.budgetUsd),
    };
    if (item === null) {
      const created = await create.mutateAsync({ ...common, parentId: parentId ?? null });
      onOpenChange(false);
      router.push(`/arbeitsbereich/${workspaceId}/auftraege/${created.workItem.id}`);
      return;
    }
    await update.mutateAsync({ workItemId: item.id, request: common });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{item === null ? t('newTitle') : t('editTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-4" data-testid="work-item-form">
            {error === null ? null : (
              <Alert variant="destructive">
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="work-item-title">{t('titleLabel')}</Label>
              <Input
                id="work-item-title"
                value={draft.title}
                maxLength={300}
                onChange={(event) => set('title', event.target.value)}
                data-testid="work-item-title"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="work-item-goal">{t('goalLabel')}</Label>
              <Textarea
                id="work-item-goal"
                value={draft.goal}
                rows={5}
                placeholder={t('goalPlaceholder')}
                onChange={(event) => set('goal', event.target.value)}
                data-testid="work-item-goal"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="work-item-criteria">{t('criteriaLabel')}</Label>
              <Textarea
                id="work-item-criteria"
                value={draft.criteria}
                rows={3}
                placeholder={t('criteriaPlaceholder')}
                onChange={(event) => set('criteria', event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('criteriaHint')}</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="work-item-assignee">{t('assigneeLabel')}</Label>
                <WorkItemAssigneeSelect
                  id="work-item-assignee"
                  value={draft.assignee}
                  members={members}
                  onChange={(value) => set('assignee', value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="work-item-priority">{t('priorityLabel')}</Label>
                <Select
                  value={draft.priority}
                  onValueChange={(value) => set('priority', value as WorkItemPriority)}
                >
                  <SelectTrigger id="work-item-priority">
                    <SelectValue>{() => wording.priority(draft.priority)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {WORK_ITEM_PRIORITIES.map((priority) => (
                      <SelectItem key={priority} value={priority}>
                        {wording.priority(priority)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t('dueLabel')}</Label>
                <DatePicker
                  value={draft.dueDate}
                  onChange={(value) => set('dueDate', value)}
                  clearable
                  aria-label={t('dueLabel')}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="work-item-budget">{t('budgetLabel')}</Label>
                <Input
                  id="work-item-budget"
                  inputMode="decimal"
                  value={draft.budgetUsd}
                  placeholder={t('budgetPlaceholder')}
                  onChange={(event) => set('budgetUsd', event.target.value)}
                />
              </div>
            </div>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={pending || !valid}
            data-testid="work-item-save"
          >
            {item === null ? t('create') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
