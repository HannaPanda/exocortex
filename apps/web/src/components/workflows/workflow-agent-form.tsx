'use client';

import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AgentProfile,
  AI_WRITE_MODES,
  type AiWriteMode,
  WORKFLOW_LIMITS,
  WORKFLOW_OUTPUT_FIELD_TYPES,
  workflowAgentNodeEffect,
  type WorkflowEnvelope,
  type WorkflowGraph,
  type WorkflowNodeOf,
  workflowNodeOutputFields,
  type WorkflowOutputField,
  type WorkflowOutputFieldType,
} from '@exocortex/contracts';
import { Button, Checkbox, Input, Label, Readout, Textarea } from '@exocortex/ui';

import { useRunFormat } from '../runs/run-inspector-format';

import { upstreamOf } from './workflow-draft';
import { ChoiceField, Field, NumberField } from './workflow-fields';
import { useWorkflowWording } from './workflow-labels';
import { WorkflowPagePicker } from './workflow-page-picker';

type AgentNode = WorkflowNodeOf<'agent'>;

const NO_PROFILE = '__default__';
const NO_MODE = '__none__';

/**
 * An agent node's settings (issue #164): what the work item is asked to do,
 * with which pages, under which profile, how freely it may write, what it may
 * spend and which fields it promises to hand back.
 *
 * The consequential settings are shown twice on purpose: as the node says
 * them, and as they will hold once the profile, the workspace and the run
 * have each had their say. A node set to write directly under a profile
 * that only proposes does not write directly, and the panel says so.
 */
export function AgentNodeForm({
  node,
  graph,
  workspaceId,
  envelope,
  profiles,
  onChange,
}: {
  node: AgentNode;
  graph: WorkflowGraph;
  workspaceId: string;
  envelope: WorkflowEnvelope;
  profiles: readonly AgentProfile[];
  onChange: (node: AgentNode) => void;
}) {
  const t = useTranslations('workflows.agent');
  const modeWording = useWorkflowWording();
  const format = useRunFormat();
  const effect = workflowAgentNodeEffect({ node, envelope, profiles });
  const defaultProfile = profiles.find((profile) => profile.isDefault) ?? null;

  const placeholders = React.useMemo(
    () => [
      ...upstreamOf(graph, node.id).flatMap((upstream) =>
        (workflowNodeOutputFields(upstream) ?? []).map(
          (field) => `{{${upstream.id}.${field.name}}}`,
        ),
      ),
      '{{input.documentId}}',
    ],
    [graph, node.id],
  );

  const id = (field: string): string => `workflow-agent-${node.id}-${field}`;

  return (
    <div className="flex flex-col gap-4" data-testid="workflow-agent-form">
      <Field
        id={id('goal')}
        label={t('goal')}
        hint={t('goalHint', { examples: placeholders.slice(0, 4).join(', ') })}
      >
        <Textarea
          id={id('goal')}
          value={node.goal}
          rows={5}
          maxLength={WORKFLOW_LIMITS.goalMaxChars}
          placeholder={t('goalPlaceholder')}
          data-testid="workflow-agent-goal"
          onChange={(event) => onChange({ ...node, goal: event.target.value })}
        />
      </Field>

      <Field id={id('pages')} label={t('pages')} hint={t('pagesHint')}>
        <WorkflowPagePicker
          workspaceId={workspaceId}
          value={node.documentIds}
          max={WORKFLOW_LIMITS.maxContextDocuments}
          label={t('pages')}
          testId="workflow-agent-pages"
          onChange={(documentIds) => onChange({ ...node, documentIds })}
        />
      </Field>

      <ChoiceField
        id={id('profile')}
        label={t('profile')}
        value={node.agentProfileId ?? NO_PROFILE}
        testId="workflow-agent-profile"
        options={[
          {
            value: NO_PROFILE,
            label:
              defaultProfile === null
                ? t('profileDefaultNone')
                : t('profileDefault', { name: defaultProfile.name }),
          },
          ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
        ]}
        onChange={(value) =>
          onChange({ ...node, agentProfileId: value === NO_PROFILE ? null : value })
        }
      />

      <ChoiceField<AiWriteMode | typeof NO_MODE>
        id={id('write-mode')}
        label={t('writeMode')}
        hint={t('writeModeHint')}
        value={node.writeMode ?? NO_MODE}
        testId="workflow-agent-write-mode"
        options={[
          { value: NO_MODE, label: t('writeModeNone') },
          ...AI_WRITE_MODES.map((mode) => ({ value: mode, label: modeWording.writeMode(mode) })),
        ]}
        onChange={(value) => onChange({ ...node, writeMode: value === NO_MODE ? null : value })}
      />

      <NumberField
        id={id('budget')}
        label={t('budget')}
        hint={t('budgetHint')}
        value={node.budgetMicroUsd}
        scale={1_000_000}
        min={0}
        placeholder={t('budgetPlaceholder')}
        testId="workflow-agent-budget"
        onChange={(budgetMicroUsd) => onChange({ ...node, budgetMicroUsd })}
      />

      <ChoiceField
        id={id('completion')}
        label={t('completion')}
        hint={t(`completionHint.${node.completion}`)}
        value={node.completion}
        options={[
          { value: 'review', label: t('completionReview') },
          { value: 'done', label: t('completionDone') },
        ]}
        onChange={(completion) => onChange({ ...node, completion })}
      />

      <section
        className="flex flex-col gap-1.5 rounded-md bg-sunken p-3"
        aria-label={t('effectiveTitle')}
        data-testid="workflow-agent-effective"
      >
        <span className="text-xs font-medium">{t('effectiveTitle')}</span>
        <Readout
          label={t('effectiveProfile')}
          value={
            effect.profile === null
              ? t('effectiveProfileNone')
              : effect.profileInherited
                ? t('effectiveProfileInherited', { name: effect.profile.name })
                : effect.profile.name
          }
        />
        <Readout
          label={t('effectiveWriteMode')}
          value={modeWording.writeMode(effect.writeMode)}
          note={effect.writeModeNarrowed ? t('effectiveWriteModeNarrowed') : undefined}
        />
        <Readout
          label={t('effectiveBudget')}
          value={format.money(effect.budgetMicroUsd)}
          note={effect.budgetNarrowed ? t('effectiveBudgetNarrowed') : undefined}
        />
      </section>

      <OutputFields
        nodeId={node.id}
        fields={node.outputFields}
        onChange={(outputFields) => onChange({ ...node, outputFields })}
      />
    </div>
  );
}

function OutputFields({
  nodeId,
  fields,
  onChange,
}: {
  nodeId: string;
  fields: readonly WorkflowOutputField[];
  onChange: (fields: WorkflowOutputField[]) => void;
}) {
  const t = useTranslations('workflows.agent');
  const update = (index: number, patch: Partial<WorkflowOutputField>): void =>
    onChange(fields.map((field, at) => (at === index ? { ...field, ...patch } : field)));
  const freeName = (): string => {
    const taken = new Set(fields.map((field) => field.name));
    for (let index = 1; ; index += 1) {
      const candidate = index === 1 ? 'result' : `result${String(index)}`;
      if (!taken.has(candidate)) return candidate;
    }
  };

  return (
    <fieldset className="flex flex-col gap-2" data-testid="workflow-agent-fields">
      <legend className="mb-1 text-sm font-medium">{t('fields')}</legend>
      <p className="text-xs text-muted-foreground">{t('fieldsHint')}</p>
      {fields.map((field, index) => {
        const prefix = `workflow-field-${nodeId}-${String(index)}`;
        return (
          <div
            key={prefix}
            className="flex flex-col gap-2 rounded-md border border-border p-2.5"
            data-testid="workflow-agent-field"
          >
            <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${prefix}-name`} className="text-xs">
                  {t('fieldName')}
                </Label>
                <Input
                  id={`${prefix}-name`}
                  value={field.name}
                  maxLength={40}
                  className="exocortex-numeric"
                  data-testid="workflow-agent-field-name"
                  onChange={(event) => update(index, { name: event.target.value.trim() })}
                />
              </div>
              <ChoiceField<WorkflowOutputFieldType>
                id={`${prefix}-type`}
                label={t('fieldType')}
                value={field.type}
                options={WORKFLOW_OUTPUT_FIELD_TYPES.map((type) => ({
                  value: type,
                  label: t(`fieldTypes.${type}`),
                }))}
                onChange={(type) =>
                  update(index, { type, values: type === 'enum' ? field.values : [] })
                }
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('fieldRemove', { name: field.name })}
                onClick={() => onChange(fields.filter((_, at) => at !== index))}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>
            {field.type === 'enum' ? (
              <Field id={`${prefix}-values`} label={t('fieldValues')} hint={t('fieldValuesHint')}>
                <Input
                  id={`${prefix}-values`}
                  value={field.values.join(', ')}
                  onChange={(event) =>
                    update(index, {
                      values: event.target.value
                        .split(',')
                        .map((value) => value.trim())
                        .filter(Boolean)
                        .slice(0, WORKFLOW_LIMITS.maxEnumValues),
                    })
                  }
                />
              </Field>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={field.required}
                onCheckedChange={(checked) => update(index, { required: checked === true })}
              />
              {t('fieldRequired')}
            </label>
          </div>
        );
      })}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        disabled={fields.length >= WORKFLOW_LIMITS.maxOutputFields}
        data-testid="workflow-agent-field-add"
        onClick={() =>
          onChange([
            ...fields,
            { name: freeName(), type: 'string', values: [], required: true, description: null },
          ])
        }
      >
        <PlusIcon className="size-4" />
        {t('fieldAdd')}
      </Button>
    </fieldset>
  );
}
