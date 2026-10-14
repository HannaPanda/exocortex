'use client';

import {
  CheckIcon,
  ClockIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  MinusCircleIcon,
  PencilIcon,
  XCircleIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type WorkItemDetail, type WorkItemRef } from '@exocortex/contracts';
import { Badge, Button, Checkbox, cn, Label, SectionRule, Textarea } from '@exocortex/ui';

import { ReadingMarkdown } from '@/components/ai/chat-markdown';
import { runInspectorHref } from '@/components/runs/run-links';
import { useAddWorkItemNote, useUpdateWorkItem } from '@/lib/api/work-item-queries';

import { useWorkItemWording } from './work-item-labels';

/**
 * The parts of a work item's detail view below its header (issues #138, #182).
 *
 * Each section edits exactly the field it shows and nothing else, so two
 * people ticking criteria and writing the result at the same time do not
 * overwrite each other's half.
 */

/**
 * One section of the page: the instrument rule on the left, the section's own
 * action at the right edge. The row has a fixed height, so a section with an
 * action and one without start their content at the same distance.
 */
export function Section({
  title,
  trailing,
  action,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<'section'>, 'title'> & {
  title: string;
  trailing?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" {...props}>
      <div className="flex min-h-8 items-center justify-between gap-3">
        <SectionRule trailing={trailing} className="min-w-0">
          {title}
        </SectionRule>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A link to another place in the product, underlined at rest so it reads as
 * one without a pointer over it (issue #182). Amber is for actions, so a page
 * title keeps the ink colour and only its underline says it can be followed.
 */
export const pageLinkClassName =
  'underline decoration-muted-foreground/60 underline-offset-4 transition-colors hover:decoration-foreground';

/**
 * A link that opens something about this work: its conversation, a run's
 * course. An action, so it wears the signal, with an icon and a touch-sized
 * row so it is never a bare word.
 */
export const actionLinkClassName =
  'inline-flex min-h-6 items-center gap-1 rounded-sm text-primary-text underline decoration-primary-text/40 underline-offset-4 transition-colors hover:decoration-primary-text [&_svg]:size-3.5 [&_svg]:shrink-0';

/** Rendered Markdown at the reading measure, for text written by a person or a run. */
function Prose({ content, testId }: { content: string; testId?: string }) {
  return (
    <div className="max-w-[68ch] text-body" data-testid={testId}>
      <ReadingMarkdown content={content} />
    </div>
  );
}

function RefList({ workspaceId, refs }: { workspaceId: string; refs: readonly WorkItemRef[] }) {
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {refs.map((ref) => (
        <li key={ref.documentId}>
          <Link
            href={`/arbeitsbereich/${workspaceId}/seite/${ref.documentId}`}
            className={pageLinkClassName}
          >
            {ref.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A label inside a section, smaller than the section's own rule. */
function SubHeading({ children, trailing }: { children: React.ReactNode; trailing?: string }) {
  return (
    <h3 className="flex items-baseline gap-2 text-meta font-medium text-muted-foreground">
      {children}
      {trailing === undefined ? null : (
        <span className="exocortex-numeric font-normal">{trailing}</span>
      )}
    </h3>
  );
}

/**
 * What was asked: the goal as it was written, the criteria the answer is held
 * to, and the pages it was given. One section, because they are one brief.
 */
export function BriefSection({
  item,
  canProgress,
}: {
  item: WorkItemDetail;
  canProgress: boolean;
}) {
  const t = useTranslations('workItems.detail');
  const update = useUpdateWorkItem(item.workspaceId);
  const criteria = item.acceptanceCriteria;

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
    <Section title={t('briefHeading')}>
      <Prose content={item.goal} testId="work-item-goal-text" />
      {criteria.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <SubHeading
            trailing={t('criteriaCount', { met: item.criteriaMet, total: item.criteriaTotal })}
          >
            {t('criteriaLabel')}
          </SubHeading>
          <ul className="flex flex-col gap-1.5" data-testid="work-item-criteria">
            {criteria.map((criterion, index) => (
              <li key={`${index}-${criterion.text}`} className="flex items-start gap-2 text-sm">
                <Checkbox
                  id={`criterion-${index}`}
                  checked={criterion.met}
                  disabled={!canProgress || update.isPending}
                  onCheckedChange={(checked) => toggle(index, checked === true)}
                  className="mt-0.5"
                />
                <Label
                  htmlFor={`criterion-${index}`}
                  className={cn('font-normal', criterion.met ? 'text-muted-foreground' : undefined)}
                >
                  {criterion.text}
                </Label>
              </li>
            ))}
          </ul>
          {update.error === null ? null : (
            <p className="text-sm text-destructive-text">{update.error.message}</p>
          )}
        </div>
      )}
      {item.contextRefs.length === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          <SubHeading>{t('contextLabel')}</SubHeading>
          <RefList workspaceId={item.workspaceId} refs={item.contextRefs} />
        </div>
      )}
    </Section>
  );
}

/**
 * What came out of it. Read first, edited on purpose (issue #182): the text
 * is rendered, and the field only appears behind "Bearbeiten" with a save and
 * a way back.
 */
export function ResultSection({
  item,
  canProgress,
}: {
  item: WorkItemDetail;
  canProgress: boolean;
}) {
  const t = useTranslations('workItems.detail');
  const update = useUpdateWorkItem(item.workspaceId);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(item.result ?? '');
  const [shownFor, setShownFor] = React.useState(item.result);
  // A result written elsewhere (an agent, another tab) replaces the field,
  // unless the reader has started typing over it.
  if (item.result !== shownFor) {
    setShownFor(item.result);
    if (draft === (shownFor ?? '')) setDraft(item.result ?? '');
  }
  const dirty = draft.trim() !== (item.result ?? '');

  const open = (): void => {
    setDraft(item.result ?? '');
    update.reset();
    setEditing(true);
  };
  const cancel = (): void => {
    setDraft(item.result ?? '');
    setEditing(false);
  };
  const save = (): void => {
    if (!dirty || update.isPending) return;
    const text = draft.trim();
    update.mutate(
      { workItemId: item.id, request: { result: text.length === 0 ? null : text } },
      { onSuccess: () => setEditing(false) },
    );
  };

  const action =
    !canProgress || editing ? null : (
      <Button variant="outline" size="sm" onClick={open} data-testid="work-item-result-edit">
        <PencilIcon />
        {item.result === null ? t('addResult') : t('editResult')}
      </Button>
    );

  return (
    <Section title={t('resultHeading')} action={action}>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft}
            rows={8}
            autoFocus
            placeholder={t('resultPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                cancel();
              } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                save();
              }
            }}
            aria-label={t('resultHeading')}
            aria-describedby="work-item-result-hint"
            data-testid="work-item-result"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!dirty || update.isPending}
              onClick={save}
              data-testid="work-item-result-save"
            >
              {t('saveResult')}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel}>
              {t('cancelEdit')}
            </Button>
            <span id="work-item-result-hint" className="text-meta text-muted-foreground">
              {t('resultHint')}
            </span>
          </div>
          {update.error === null ? null : (
            <p className="text-sm text-destructive-text">{update.error.message}</p>
          )}
        </div>
      ) : item.result === null ? (
        <p className="text-sm text-muted-foreground">{t('noResult')}</p>
      ) : (
        <Prose content={item.result} testId="work-item-result-text" />
      )}
      {item.resultRefs.length === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          <SubHeading>{t('resultPagesLabel')}</SubHeading>
          <RefList workspaceId={item.workspaceId} refs={item.resultRefs} />
        </div>
      )}
      <StructuredResult item={item} />
    </Section>
  );
}

/**
 * The fields the result promises and what is filled in (issue #162). Shown,
 * not edited here: they are written by the run that does the work, checked
 * by the API on every write, and read by the workflow that asked for them.
 */
function StructuredResult({ item }: { item: WorkItemDetail }) {
  const t = useTranslations('workItems.detail');
  if (item.resultFields.length === 0 && item.workflow === null) return null;
  const values = item.structuredResult ?? {};
  return (
    <div className="flex flex-col gap-2">
      <SubHeading>{t('structuredHeading')}</SubHeading>
      {item.workflow === null ? null : (
        <p className="flex flex-wrap items-center gap-x-2 text-meta text-muted-foreground">
          {t('fromWorkflow', { node: item.workflow.nodeId })}
          {/* The run that asked for this work, drawn on its graph (issue #164). */}
          <Link
            href={`/arbeitsbereich/${item.workspaceId}/workflows/${item.workflow.workflowId}/laeufe/${item.workflow.runId}`}
            className={actionLinkClassName}
            data-testid="work-item-workflow-run"
          >
            <ListTreeIcon aria-hidden />
            {t('openWorkflowRun')}
          </Link>
        </p>
      )}
      {item.resultFields.length === 0 ? null : (
        <dl
          className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"
          data-testid="work-item-structured-result"
        >
          {item.resultFields.map((field) => {
            const value = values[field.name];
            const missing = value === undefined || value === null;
            return (
              <React.Fragment key={field.name}>
                <dt className="font-mono text-xs leading-6 text-muted-foreground">
                  {field.name}
                  {field.required ? (
                    <span className="sr-only"> ({t('structuredRequired')})</span>
                  ) : null}
                  {field.required ? <span aria-hidden="true">*</span> : null}
                </dt>
                <dd className="min-w-0 break-words">
                  {missing ? (
                    <Badge variant="outline">{t('structuredMissing')}</Badge>
                  ) : (
                    String(value)
                  )}
                </dd>
              </React.Fragment>
            );
          })}
        </dl>
      )}
      {item.resultFields.length === 0 ? null : (
        <p className="text-meta text-muted-foreground">{t('structuredHint')}</p>
      )}
    </div>
  );
}

type RunStatus = WorkItemDetail['runs'][number]['status'];

/** A run's state as an icon and a word, never colour alone; amber only while it is live. */
function RunState({ status }: { status: RunStatus }) {
  const t = useTranslations('workItems.detail');
  const [Icon, tone] = ((): [typeof CheckIcon, string] => {
    switch (status) {
      case 'running':
        return [LoaderCircleIcon, 'text-primary-text [&_svg]:motion-safe:animate-spin'];
      case 'pending':
        return [ClockIcon, 'text-primary-text'];
      case 'completed':
        return [CheckIcon, 'text-foreground'];
      case 'cancelled':
        return [MinusCircleIcon, 'text-muted-foreground'];
      default:
        return [XCircleIcon, 'text-destructive-text'];
    }
  })();
  return (
    <span className={cn('inline-flex w-36 shrink-0 items-center gap-1.5', tone)}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {t(`runStatus.${status}`)}
    </span>
  );
}

/** How many runs show before the rest is asked for. */
const RUNS_SHOWN = 5;

export function RunsSection({ item }: { item: WorkItemDetail }) {
  const t = useTranslations('workItems.detail');
  const tProfile = useTranslations('agentProfiles.workItem');
  const tRun = useTranslations('runInspector.links');
  const wording = useWorkItemWording();
  const [showAll, setShowAll] = React.useState(false);
  const runs = showAll ? item.runs : item.runs.slice(0, RUNS_SHOWN);

  return (
    <Section
      title={t('runsHeading')}
      trailing={item.runs.length === 0 ? undefined : item.runs.length}
    >
      {/* The budget that holds: the stricter of the item's and its profile's (issue #143),
          counted over everything delegated below it (issue #144). */}
      {item.effectiveBudgetMicroUsd === null ? null : (
        <p className="text-meta text-muted-foreground" data-testid="work-item-budget">
          {t(item.subtreeSpentMicroUsd > item.spentMicroUsd ? 'budgetWithChildren' : 'budget', {
            spent: wording.money(item.subtreeSpentMicroUsd),
            budget: wording.money(item.effectiveBudgetMicroUsd),
          })}
          {item.budgetLimitedBy === null || item.budgetRemainingMicroUsd === null
            ? null
            : ` · ${t('budgetLimitedBy', {
                remaining: wording.money(Math.max(0, item.budgetRemainingMicroUsd)),
                title: item.budgetLimitedBy.title,
              })}`}
        </p>
      )}
      {item.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noRuns')}</p>
      ) : (
        <ul className="flex flex-col text-sm" data-testid="work-item-runs">
          {runs.map((run) => (
            <li
              key={run.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2 last:border-b-0"
            >
              <RunState status={run.status} />
              <span className="exocortex-numeric text-meta text-muted-foreground">
                {wording.moment(run.createdAt)}
              </span>
              <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground">
                {run.model}
                {run.agentProfile === null
                  ? null
                  : ` · ${tProfile('runProfile', {
                      name: run.agentProfile.name,
                      revision: run.agentProfile.revision,
                    })}`}
              </span>
              {run.costMicroUsd === null ? null : (
                <span className="exocortex-numeric text-meta text-muted-foreground">
                  {wording.money(run.costMicroUsd)}
                </span>
              )}
              <span className="flex items-center gap-3">
                {/* What the run did and what its prompt was made of (issue #145). */}
                <Link
                  href={runInspectorHref(item.workspaceId, run.id)}
                  className={actionLinkClassName}
                >
                  <ListTreeIcon aria-hidden />
                  {tRun('fromWorkItem')}
                </Link>
                {run.conversationId === null ? null : (
                  <Link
                    href={`/chats?fortsetzen=${run.conversationId}`}
                    className={actionLinkClassName}
                  >
                    <MessageSquareIcon aria-hidden />
                    {t('openConversation')}
                  </Link>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {item.runs.length <= RUNS_SHOWN ? null : (
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowAll((shown) => !shown)}
            aria-expanded={showAll}
          >
            {showAll ? t('showFewer') : t('runsShowAll', { count: item.runs.length })}
          </Button>
        </div>
      )}
    </Section>
  );
}

/** How many history entries show before the rest is asked for. */
const EVENTS_SHOWN = 3;

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
  const [showAll, setShowAll] = React.useState(false);
  // Newest first, as the API sends them: the latest entries are the ones a
  // returning reader is missing.
  const events = showAll ? item.events : item.events.slice(0, EVENTS_SHOWN);

  const submit = async (): Promise<void> => {
    const text = note.trim();
    if (text.length === 0) return;
    await addNote.mutateAsync({ workItemId: item.id, request: { note: text } });
    setNote('');
  };

  return (
    <Section title={t('historyHeading')} trailing={item.events.length}>
      <ol className="flex flex-col gap-2.5 text-sm" data-testid="work-item-history">
        {events.map((event) => (
          <li key={event.id} className="grid grid-cols-[auto_1fr] gap-x-3">
            <span className="exocortex-numeric pt-px text-meta text-muted-foreground">
              {wording.moment(event.createdAt)}
            </span>
            <span className="min-w-0 break-words">
              <span className="font-medium">{wording.participant(event.actor)}</span>
              {event.actor.kind === 'agent' && event.agentLabel !== null
                ? ` (${event.agentLabel})`
                : ''}{' '}
              <span className="text-muted-foreground">
                · {wording.event(event)}
                {event.data.reason === undefined ? '' : `: ${event.data.reason}`}
              </span>
            </span>
            {event.note === null ? null : (
              <span className="col-start-2 whitespace-pre-wrap break-words">{event.note}</span>
            )}
          </li>
        ))}
      </ol>
      {item.events.length <= EVENTS_SHOWN ? null : (
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowAll((shown) => !shown)}
            aria-expanded={showAll}
            data-testid="work-item-history-toggle"
          >
            {showAll ? t('showFewer') : t('historyShowAll', { count: item.events.length })}
          </Button>
        </div>
      )}
      {canProgress ? (
        <div className="flex flex-col gap-2 pt-1">
          <Label htmlFor="work-item-note">{t('noteLabel')}</Label>
          <Textarea
            id="work-item-note"
            value={note}
            rows={2}
            placeholder={t('notePlaceholder')}
            onChange={(event) => setNote(event.target.value)}
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
    </Section>
  );
}
