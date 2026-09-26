'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type WorkItemDetail, type WorkItemRef } from '@exocortex/contracts';
import { Badge, Button, Checkbox, Label, Textarea } from '@exocortex/ui';

import { useAddWorkItemNote, useUpdateWorkItem } from '@/lib/api/work-item-queries';

import { statusVariant, useWorkItemWording } from './work-item-labels';

/**
 * The parts of a work item's detail view below its header (issue #138).
 *
 * Each section edits exactly the field it shows and nothing else, so two
 * people ticking criteria and writing the result at the same time do not
 * overwrite each other's half.
 */

export function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function RefList({ workspaceId, refs }: { workspaceId: string; refs: readonly WorkItemRef[] }) {
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {refs.map((ref) => (
        <li key={ref.documentId}>
          <Link
            href={`/arbeitsbereich/${workspaceId}/seite/${ref.documentId}`}
            className="hover:underline"
          >
            {ref.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function CriteriaSection({
  item,
  canProgress,
}: {
  item: WorkItemDetail;
  canProgress: boolean;
}) {
  const t = useTranslations('workItems.detail');
  const update = useUpdateWorkItem(item.workspaceId);
  const criteria = item.acceptanceCriteria;
  if (criteria.length === 0) return null;

  const toggle = (index: number, met: boolean): void => {
    update.mutate({
      workItemId: item.id,
      request: {
        acceptanceCriteria: criteria.map((criterion, position) =>
          position === index ? { ...criterion, met } : criterion,
        ),
      },
    });
  };

  return (
    <Section title={t('criteriaHeading', { met: item.criteriaMet, total: item.criteriaTotal })}>
      <ul className="flex flex-col gap-2" data-testid="work-item-criteria">
        {criteria.map((criterion, index) => (
          <li key={`${index}-${criterion.text}`} className="flex items-start gap-2 text-sm">
            <Checkbox
              id={`criterion-${index}`}
              checked={criterion.met}
              disabled={!canProgress || update.isPending}
              onCheckedChange={(checked) => toggle(index, checked === true)}
              className="mt-0.5"
            />
            <Label htmlFor={`criterion-${index}`} className="font-normal">
              {criterion.text}
            </Label>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function ContextSection({ item }: { item: WorkItemDetail }) {
  const t = useTranslations('workItems.detail');
  if (item.contextRefs.length === 0) return null;
  return (
    <Section title={t('contextHeading')}>
      <RefList workspaceId={item.workspaceId} refs={item.contextRefs} />
    </Section>
  );
}

export function ResultSection({
  item,
  canProgress,
}: {
  item: WorkItemDetail;
  canProgress: boolean;
}) {
  const t = useTranslations('workItems.detail');
  const update = useUpdateWorkItem(item.workspaceId);
  const [draft, setDraft] = React.useState(item.result ?? '');
  const [shownFor, setShownFor] = React.useState(item.result);
  // A result written elsewhere (an agent, another tab) replaces the field,
  // unless the reader has started typing over it.
  if (item.result !== shownFor) {
    setShownFor(item.result);
    if (draft === (shownFor ?? '')) setDraft(item.result ?? '');
  }
  const dirty = draft.trim() !== (item.result ?? '');

  return (
    <Section title={t('resultHeading')}>
      {canProgress ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft}
            rows={4}
            placeholder={t('resultPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={t('resultHeading')}
            data-testid="work-item-result"
          />
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={!dirty || update.isPending}
              onClick={() =>
                update.mutate({
                  workItemId: item.id,
                  request: { result: draft.trim().length === 0 ? null : draft.trim() },
                })
              }
            >
              {t('saveResult')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm whitespace-pre-wrap">{item.result ?? t('noResult')}</p>
      )}
      {item.resultRefs.length === 0 ? null : (
        <RefList workspaceId={item.workspaceId} refs={item.resultRefs} />
      )}
    </Section>
  );
}

export function ChildrenSection({
  item,
  onAddChild,
}: {
  item: WorkItemDetail;
  onAddChild: (() => void) | null;
}) {
  const t = useTranslations('workItems.detail');
  const wording = useWorkItemWording();
  if (item.children.length === 0 && onAddChild === null) return null;
  return (
    <Section
      title={t('childrenHeading')}
      action={
        onAddChild === null ? null : (
          <Button size="sm" variant="ghost" onClick={onAddChild} data-testid="work-item-add-child">
            {t('addChild')}
          </Button>
        )
      }
    >
      {item.children.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noChildren')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {item.children.map((child) => (
            <li key={child.id} className="flex items-center gap-2">
              <Badge variant={statusVariant(child.status)}>{wording.status(child.status)}</Badge>
              <Link
                href={`/arbeitsbereich/${item.workspaceId}/auftraege/${child.id}`}
                className="hover:underline"
              >
                {child.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function runVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'completed') return 'default';
  if (status === 'pending' || status === 'running') return 'secondary';
  if (status === 'cancelled') return 'outline';
  return 'destructive';
}

export function RunsSection({ item, action }: { item: WorkItemDetail; action: React.ReactNode }) {
  const t = useTranslations('workItems.detail');
  const wording = useWorkItemWording();
  return (
    <Section title={t('runsHeading')} action={action}>
      {item.budgetMicroUsd === null ? null : (
        <p className="text-xs text-muted-foreground">
          {t('budget', {
            spent: wording.money(item.spentMicroUsd),
            budget: wording.money(item.budgetMicroUsd),
          })}
        </p>
      )}
      {item.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noRuns')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm" data-testid="work-item-runs">
          {item.runs.map((run) => (
            <li key={run.id} className="flex flex-wrap items-center gap-2">
              <Badge variant={runVariant(run.status)}>{t(`runStatus.${run.status}`)}</Badge>
              <span className="text-muted-foreground">{wording.moment(run.createdAt)}</span>
              <span className="text-muted-foreground">{run.model}</span>
              {run.costMicroUsd === null ? null : (
                <span className="text-muted-foreground">{wording.money(run.costMicroUsd)}</span>
              )}
              {run.conversationId === null ? null : (
                <Link href={`/chats?fortsetzen=${run.conversationId}`} className="hover:underline">
                  {t('openConversation')}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function HistorySection({
  item,
  canProgress,
}: {
  item: WorkItemDetail;
  canProgress: boolean;
}) {
  const t = useTranslations('workItems.detail');
  const wording = useWorkItemWording();
  const addNote = useAddWorkItemNote(item.workspaceId);
  const [note, setNote] = React.useState('');

  const submit = async (): Promise<void> => {
    const text = note.trim();
    if (text.length === 0) return;
    await addNote.mutateAsync({ workItemId: item.id, request: { note: text } });
    setNote('');
  };

  return (
    <Section title={t('historyHeading')}>
      {canProgress ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={note}
            rows={2}
            placeholder={t('notePlaceholder')}
            onChange={(event) => setNote(event.target.value)}
            aria-label={t('noteLabel')}
            data-testid="work-item-note"
          />
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={note.trim().length === 0 || addNote.isPending}
              onClick={() => void submit()}
            >
              {t('addNote')}
            </Button>
          </div>
        </div>
      ) : null}
      <ol className="flex flex-col gap-2 text-sm" data-testid="work-item-history">
        {item.events.map((event) => (
          <li key={event.id} className="flex flex-col">
            <span>
              <span className="font-medium">{wording.participant(event.actor)}</span>
              {event.actor.kind === 'agent' && event.agentLabel !== null
                ? ` (${event.agentLabel})`
                : ''}{' '}
              · {wording.event(event)}
              {event.data.reason === undefined ? '' : `: ${event.data.reason}`}
            </span>
            {event.note === null ? null : (
              <span className="whitespace-pre-wrap text-muted-foreground">{event.note}</span>
            )}
            <span className="text-xs text-muted-foreground">{wording.moment(event.createdAt)}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
