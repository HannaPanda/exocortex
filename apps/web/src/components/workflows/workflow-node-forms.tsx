'use client';

import { useTranslations } from 'next-intl';

import {
  isInputSource,
  WORKFLOW_APPROVAL_NOTE_MODES,
  WORKFLOW_CONDITION_OPERATORS,
  WORKFLOW_END_OUTCOMES,
  WORKFLOW_LIMITS,
  type WorkflowConditionOperator,
  type WorkflowEventType,
  type WorkflowGraph,
  type WorkflowNodeOf,
  workflowNodeOutputFields,
  type WorkflowOutputField,
  type WorkflowSchedule,
  type WorkspaceMember,
} from '@exocortex/contracts';
import { Checkbox, Input, Textarea } from '@exocortex/ui';

import { TRIGGER_ORDER, useAutomationWording } from '../automations/automation-labels';
import {
  AutomationScheduleFields,
  fromLocalInput,
  type ScheduleDraft,
  toLocalInput,
} from '../automations/automation-schedule-fields';

import { readableSources } from './workflow-draft';
import { ChoiceField, Field, NumberField } from './workflow-fields';
import { WorkflowPagePicker } from './workflow-page-picker';

/**
 * The settings of every node type but the agent (issue #164), one small
 * form each. A schedule and an event trigger reuse the automation's own
 * fields and words, because a workflow's clock is the automation's clock
 * (ADR-038) and the two must not be described differently.
 */

// -- triggers -----------------------------------------------------------------

function toDraft(schedule: WorkflowSchedule): ScheduleDraft {
  return {
    scheduleKind: schedule.kind,
    scheduleAt: schedule.kind === 'ONCE' ? toLocalInput(schedule.at) : '',
    scheduleTime: 'time' in schedule ? schedule.time : '07:00',
    scheduleWeekday: schedule.kind === 'WEEKLY' ? schedule.weekday : 1,
    scheduleDayOfMonth: schedule.kind === 'MONTHLY' ? schedule.dayOfMonth : 1,
    scheduleCron: schedule.kind === 'CRON' ? schedule.cron : '0 7 * * 1',
    scheduleTimeZone: schedule.timeZone,
  };
}

/** The schedule a draft describes; an instant that does not parse keeps the old one. */
function fromDraft(draft: ScheduleDraft, previous: WorkflowSchedule): WorkflowSchedule {
  const timeZone = draft.scheduleTimeZone;
  switch (draft.scheduleKind) {
    case 'ONCE': {
      const at =
        fromLocalInput(draft.scheduleAt) ??
        (previous.kind === 'ONCE' ? previous.at : new Date().toISOString());
      return { kind: 'ONCE', at, timeZone };
    }
    case 'DAILY':
      return { kind: 'DAILY', time: draft.scheduleTime, timeZone };
    case 'WEEKLY':
      return { kind: 'WEEKLY', time: draft.scheduleTime, weekday: draft.scheduleWeekday, timeZone };
    case 'MONTHLY':
      return {
        kind: 'MONTHLY',
        time: draft.scheduleTime,
        dayOfMonth: draft.scheduleDayOfMonth,
        timeZone,
      };
    case 'CRON':
      return { kind: 'CRON', cron: draft.scheduleCron, timeZone };
  }
}

export function ScheduleTriggerForm({
  node,
  onChange,
}: {
  node: WorkflowNodeOf<'trigger.schedule'>;
  onChange: (node: WorkflowNodeOf<'trigger.schedule'>) => void;
}) {
  const draft = toDraft(node.schedule);
  return (
    <AutomationScheduleFields
      draft={draft}
      onChange={(patch) =>
        onChange({ ...node, schedule: fromDraft({ ...draft, ...patch }, node.schedule) })
      }
    />
  );
}

const EVENT_ORDER = TRIGGER_ORDER.filter(
  (trigger): trigger is WorkflowEventType => trigger !== 'SCHEDULE',
);

export function EventTriggerForm({
  node,
  workspaceId,
  onChange,
}: {
  node: WorkflowNodeOf<'trigger.event'>;
  workspaceId: string;
  onChange: (node: WorkflowNodeOf<'trigger.event'>) => void;
}) {
  const t = useTranslations('workflows.event');
  const automation = useAutomationWording();
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-1.5" data-testid="workflow-event-types">
        <legend className="mb-1 text-sm font-medium">{t('events')}</legend>
        {EVENT_ORDER.map((event) => (
          <label key={event} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={node.events.includes(event)}
              onCheckedChange={(checked) =>
                onChange({
                  ...node,
                  events:
                    checked === true
                      ? EVENT_ORDER.filter(
                          (entry) => entry === event || node.events.includes(entry),
                        )
                      : node.events.filter((entry) => entry !== event),
                })
              }
            />
            {automation.trigger(event)}
          </label>
        ))}
      </fieldset>
      <Field id={`workflow-event-scope-${node.id}`} label={t('scope')} hint={t('scopeHint')}>
        <WorkflowPagePicker
          workspaceId={workspaceId}
          value={node.scopeDocumentId === null ? [] : [node.scopeDocumentId]}
          max={1}
          label={t('scope')}
          testId="workflow-event-scope"
          onChange={(ids) => onChange({ ...node, scopeDocumentId: ids[0] ?? null })}
        />
      </Field>
    </div>
  );
}

// -- control --------------------------------------------------------------------

/** Operators that compare against no value. */
const UNARY: readonly WorkflowConditionOperator[] = ['present', 'absent', 'is_true', 'is_false'];

const OPERATORS_BY_TYPE: Readonly<
  Record<WorkflowOutputField['type'] | 'input', readonly WorkflowConditionOperator[]>
> = {
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'present', 'absent'],
  boolean: ['is_true', 'is_false', 'present', 'absent'],
  string: ['eq', 'neq', 'present', 'absent'],
  enum: ['eq', 'neq', 'present', 'absent'],
  input: WORKFLOW_CONDITION_OPERATORS,
};

const INPUT_SOURCE = '__input__';

export function ConditionForm({
  node,
  graph,
  onChange,
}: {
  node: WorkflowNodeOf<'condition'>;
  graph: WorkflowGraph;
  onChange: (node: WorkflowNodeOf<'condition'>) => void;
}) {
  const t = useTranslations('workflows.condition');
  const sources = readableSources(graph, node.id);
  const options = sources.flatMap((source) =>
    (workflowNodeOutputFields(source) ?? []).map((field) => ({
      value: `${source.id}.${field.name}`,
      label: `${source.label ?? source.id} · ${field.name}`,
      nodeId: source.id,
      field,
    })),
  );
  const fromInput = isInputSource(node.source);
  const sourceValue = isInputSource(node.source)
    ? INPUT_SOURCE
    : `${node.source.nodeId}.${node.source.field}`;
  const chosen = options.find((option) => option.value === sourceValue);
  const type: WorkflowOutputField['type'] | 'input' = fromInput
    ? 'input'
    : (chosen?.field.type ?? 'input');
  const operators = OPERATORS_BY_TYPE[type];
  const id = (part: string): string => `workflow-condition-${node.id}-${part}`;

  return (
    <div className="flex flex-col gap-4" data-testid="workflow-condition-form">
      <ChoiceField
        id={id('source')}
        label={t('source')}
        hint={options.length === 0 ? t('sourceNone') : t('sourceHint')}
        value={sourceValue}
        testId="workflow-condition-source"
        options={[
          ...options.map((option) => ({ value: option.value, label: option.label })),
          ...(chosen === undefined && !fromInput
            ? [{ value: sourceValue, label: t('sourceMissing', { source: sourceValue }) }]
            : []),
          { value: INPUT_SOURCE, label: t('sourceInput') },
        ]}
        onChange={(value) => {
          if (value === INPUT_SOURCE) {
            onChange({
              ...node,
              source: { input: 'documentId' },
              operator: 'present',
              value: null,
            });
            return;
          }
          const option = options.find((entry) => entry.value === value);
          if (option === undefined) return;
          const nextOperators = OPERATORS_BY_TYPE[option.field.type];
          onChange({
            ...node,
            source: { nodeId: option.nodeId, field: option.field.name },
            operator: nextOperators.includes(node.operator) ? node.operator : nextOperators[0]!,
            value: null,
          });
        }}
      />
      {isInputSource(node.source) ? (
        <Field id={id('input')} label={t('inputKey')} hint={t('inputKeyHint')}>
          <Input
            id={id('input')}
            value={node.source.input}
            maxLength={40}
            className="exocortex-numeric"
            onChange={(event) =>
              onChange({ ...node, source: { input: event.target.value.trim() } })
            }
          />
        </Field>
      ) : null}
      <ChoiceField<WorkflowConditionOperator>
        id={id('operator')}
        label={t('operator')}
        value={node.operator}
        testId="workflow-condition-operator"
        options={operators.map((operator) => ({
          value: operator,
          label: t(`operators.${operator}`),
        }))}
        onChange={(operator) =>
          onChange({ ...node, operator, value: UNARY.includes(operator) ? null : node.value })
        }
      />
      {UNARY.includes(node.operator) ? null : (
        <ConditionValue
          id={id('value')}
          field={chosen?.field ?? null}
          value={node.value}
          onChange={(value) => onChange({ ...node, value })}
        />
      )}
    </div>
  );
}

function ConditionValue({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: WorkflowOutputField | null;
  value: string | number | boolean | null;
  onChange: (value: string | number | boolean | null) => void;
}) {
  const t = useTranslations('workflows.condition');
  if (field?.type === 'number') {
    return (
      <NumberField
        id={id}
        label={t('value')}
        value={typeof value === 'number' ? value : null}
        integer={false}
        testId="workflow-condition-value"
        onChange={onChange}
      />
    );
  }
  if (field?.type === 'enum' && field.values.length > 0) {
    return (
      <ChoiceField
        id={id}
        label={t('value')}
        value={typeof value === 'string' ? value : ''}
        testId="workflow-condition-value"
        options={[
          ...(typeof value === 'string' && field.values.includes(value)
            ? []
            : [{ value: '', label: t('valueChoose') }]),
          ...field.values.map((entry) => ({ value: entry, label: entry })),
        ]}
        onChange={(next) => onChange(next.length === 0 ? null : next)}
      />
    );
  }
  return (
    <Field id={id} label={t('value')} hint={field === null ? t('valueInputHint') : undefined}>
      <Input
        id={id}
        value={value === null ? '' : String(value)}
        maxLength={200}
        data-testid="workflow-condition-value"
        onChange={(event) => onChange(event.target.value.length === 0 ? null : event.target.value)}
      />
    </Field>
  );
}

export function JoinForm({
  node,
  onChange,
}: {
  node: WorkflowNodeOf<'join'>;
  onChange: (node: WorkflowNodeOf<'join'>) => void;
}) {
  const t = useTranslations('workflows.join');
  return (
    <ChoiceField
      id={`workflow-join-${node.id}`}
      label={t('policy')}
      hint={t(`policyHint.${node.policy}`)}
      value={node.policy}
      options={[
        { value: 'all', label: t('all') },
        { value: 'any', label: t('any') },
      ]}
      onChange={(policy) => onChange({ ...node, policy })}
    />
  );
}

const ANYBODY = '__anybody__';

export function ApprovalForm({
  node,
  members,
  onChange,
}: {
  node: WorkflowNodeOf<'approval'>;
  members: readonly WorkspaceMember[];
  onChange: (node: WorkflowNodeOf<'approval'>) => void;
}) {
  const t = useTranslations('workflows.approval');
  const id = (part: string): string => `workflow-approval-${node.id}-${part}`;
  const assignee = members.find((member) => member.userId === node.assigneeUserId);
  return (
    <div className="flex flex-col gap-4" data-testid="workflow-approval-form">
      <Field id={id('title')} label={t('title')}>
        <Input
          id={id('title')}
          value={node.title}
          maxLength={WORKFLOW_LIMITS.labelMaxChars}
          placeholder={t('titlePlaceholder')}
          data-testid="workflow-approval-title"
          onChange={(event) => onChange({ ...node, title: event.target.value })}
        />
      </Field>
      <Field id={id('question')} label={t('question')} hint={t('questionHint')}>
        <Textarea
          id={id('question')}
          value={node.question}
          rows={3}
          maxLength={WORKFLOW_LIMITS.questionMaxChars}
          data-testid="workflow-approval-question"
          onChange={(event) => onChange({ ...node, question: event.target.value })}
        />
      </Field>
      <ChoiceField
        id={id('assignee')}
        label={t('assignee')}
        hint={t('assigneeHint')}
        value={node.assigneeUserId ?? ANYBODY}
        options={[
          { value: ANYBODY, label: t('anybody') },
          ...(node.assigneeUserId !== null && assignee === undefined
            ? [{ value: node.assigneeUserId, label: t('assigneeGone') }]
            : []),
          ...members.map((member) => ({ value: member.userId, label: member.name })),
        ]}
        onChange={(value) =>
          onChange({ ...node, assigneeUserId: value === ANYBODY ? null : value })
        }
      />
      <ChoiceField
        id={id('note')}
        label={t('note')}
        value={node.note}
        options={WORKFLOW_APPROVAL_NOTE_MODES.map((mode) => ({
          value: mode,
          label: t(`noteModes.${mode}`),
        }))}
        onChange={(note) => onChange({ ...node, note })}
      />
    </div>
  );
}

export function EndForm({
  node,
  onChange,
}: {
  node: WorkflowNodeOf<'end'>;
  onChange: (node: WorkflowNodeOf<'end'>) => void;
}) {
  const t = useTranslations('workflows.end');
  const id = (part: string): string => `workflow-end-${node.id}-${part}`;
  return (
    <div className="flex flex-col gap-4">
      <ChoiceField
        id={id('outcome')}
        label={t('outcome')}
        hint={t(`outcomeHint.${node.outcome}`)}
        value={node.outcome}
        testId="workflow-end-outcome"
        options={WORKFLOW_END_OUTCOMES.map((outcome) => ({
          value: outcome,
          label: t(`outcomes.${outcome}`),
        }))}
        onChange={(outcome) => onChange({ ...node, outcome })}
      />
      <Field id={id('summary')} label={t('summary')} hint={t('summaryHint')}>
        <Textarea
          id={id('summary')}
          value={node.summary ?? ''}
          rows={3}
          maxLength={WORKFLOW_LIMITS.summaryMaxChars}
          onChange={(event) =>
            onChange({
              ...node,
              summary: event.target.value.length === 0 ? null : event.target.value,
            })
          }
        />
      </Field>
    </div>
  );
}

/** What a node type without settings does, said once where its settings would be. */
export function NodeExplanation({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}
