'use client';

import { CopyIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  type AgentProfile,
  WORKFLOW_FAN_OUT_HANDLES,
  WORKFLOW_LIMITS,
  WORKFLOW_NODE_HANDLES,
  type WorkflowEnvelope,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowProblem,
  type WorkspaceMember,
} from '@exocortex/contracts';
import { Button, Input, Readout, SectionRule, Textarea } from '@exocortex/ui';

import { useRunFormat } from '../runs/run-inspector-format';

import { AgentNodeForm } from './workflow-agent-form';
import { connect, removeEdges, replaceNode } from './workflow-draft';
import { ChoiceField, Field, MoneyField, NumberField } from './workflow-fields';
import { NODE_ICONS, useWorkflowWording } from './workflow-labels';
import {
  ApprovalForm,
  ConditionForm,
  EndForm,
  EventTriggerForm,
  JoinForm,
  NodeExplanation,
  ScheduleTriggerForm,
} from './workflow-node-forms';
import { WorkflowProblemList } from './workflow-problems';

/**
 * The right-hand side of the editor (issue #164): whatever is selected on the
 * canvas, or the workflow itself when nothing is.
 *
 * The connections of a node are edited here too, one choice per handle. That
 * is what makes a graph buildable without a pointer: a handle's target is a
 * list of the other nodes, and a fan-out keeps a list of branches.
 */

interface Shared {
  graph: WorkflowGraph;
  problems: readonly WorkflowProblem[];
  readOnly: boolean;
  onGraphChange: (graph: WorkflowGraph) => void;
  onSelectProblem: (problem: WorkflowProblem) => void;
}

export function NodeInspector({
  node,
  workspaceId,
  envelope,
  profiles,
  members,
  onDuplicate,
  onDelete,
  ...shared
}: Shared & {
  node: WorkflowNode;
  workspaceId: string;
  envelope: WorkflowEnvelope;
  profiles: readonly AgentProfile[];
  members: readonly WorkspaceMember[];
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('workflows.inspector');
  const wording = useWorkflowWording();
  const { graph, onGraphChange, readOnly } = shared;
  const Icon = NODE_ICONS[node.type];
  const change = (next: WorkflowNode): void => onGraphChange(replaceNode(graph, next));
  const own = shared.problems.filter((problem) => problem.nodeId === node.id);

  return (
    <div className="flex flex-col gap-5" data-testid="workflow-node-inspector">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">{wording.type(node.type)}</h2>
          <p className="text-xs text-muted-foreground">{wording.typeHint(node.type)}</p>
        </div>
        <span className="exocortex-numeric shrink-0 rounded-sm bg-sunken px-1.5 py-0.5 text-micro text-muted-foreground">
          {node.id}
        </span>
      </div>

      {own.length === 0 ? null : (
        <WorkflowProblemList
          problems={own}
          graph={graph}
          onSelect={shared.onSelectProblem}
          compact
        />
      )}

      <fieldset disabled={readOnly} className="flex flex-col gap-4">
        <Field id={`workflow-node-${node.id}-label`} label={t('label')} hint={t('labelHint')}>
          <Input
            id={`workflow-node-${node.id}-label`}
            value={node.label ?? ''}
            maxLength={WORKFLOW_LIMITS.labelMaxChars}
            placeholder={node.id}
            data-testid="workflow-node-label"
            onChange={(event) =>
              change({
                ...node,
                label: event.target.value.length === 0 ? null : event.target.value,
              })
            }
          />
        </Field>
        <NodeForm
          node={node}
          graph={graph}
          workspaceId={workspaceId}
          envelope={envelope}
          profiles={profiles}
          members={members}
          onChange={change}
        />
      </fieldset>

      <Connections node={node} {...shared} />

      {readOnly ? null : (
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={onDuplicate}
            data-testid="workflow-node-duplicate"
          >
            <CopyIcon className="size-4" />
            {t('duplicate')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete} data-testid="workflow-node-delete">
            <Trash2Icon className="size-4" />
            {t('delete')}
          </Button>
        </div>
      )}
    </div>
  );
}

function NodeForm({
  node,
  graph,
  workspaceId,
  envelope,
  profiles,
  members,
  onChange,
}: {
  node: WorkflowNode;
  graph: WorkflowGraph;
  workspaceId: string;
  envelope: WorkflowEnvelope;
  profiles: readonly AgentProfile[];
  members: readonly WorkspaceMember[];
  onChange: (node: WorkflowNode) => void;
}) {
  const t = useTranslations('workflows.inspector');
  switch (node.type) {
    case 'trigger.manual':
      return <NodeExplanation text={t('manualExplanation')} />;
    case 'trigger.schedule':
      return <ScheduleTriggerForm node={node} onChange={onChange} />;
    case 'trigger.event':
      return <EventTriggerForm node={node} workspaceId={workspaceId} onChange={onChange} />;
    case 'agent':
      return (
        <AgentNodeForm
          node={node}
          graph={graph}
          workspaceId={workspaceId}
          envelope={envelope}
          profiles={profiles}
          onChange={onChange}
        />
      );
    case 'condition':
      return <ConditionForm node={node} graph={graph} onChange={onChange} />;
    case 'parallel':
      return <NodeExplanation text={t('parallelExplanation')} />;
    case 'join':
      return <JoinForm node={node} onChange={onChange} />;
    case 'approval':
      return <ApprovalForm node={node} members={members} onChange={onChange} />;
    case 'end':
      return <EndForm node={node} onChange={onChange} />;
  }
}

const UNCONNECTED = '__none__';

/** Where each handle of a node leads, as choices. */
function Connections({ node, graph, readOnly, onGraphChange }: Shared & { node: WorkflowNode }) {
  const t = useTranslations('workflows.inspector');
  const wording = useWorkflowWording();
  const handles = WORKFLOW_NODE_HANDLES[node.type];
  if (handles.length === 0) return null;
  const fanOut = WORKFLOW_FAN_OUT_HANDLES[node.type];
  const targets = graph.nodes.filter(
    (candidate) => candidate.id !== node.id && !candidate.type.startsWith('trigger.'),
  );
  const name = (id: string): string => {
    const target = graph.nodes.find((candidate) => candidate.id === id);
    return target === undefined
      ? id
      : `${target.label ?? target.id} (${wording.type(target.type)})`;
  };
  const options = [
    { value: UNCONNECTED, label: t('unconnected') },
    ...targets.map((target) => ({ value: target.id, label: name(target.id) })),
  ];

  return (
    <section className="flex flex-col gap-3" data-testid="workflow-node-connections">
      <SectionRule as="h3">{t('connections')}</SectionRule>
      {handles.map((handle) => {
        const edges = graph.edges.filter(
          (edge) => edge.source.nodeId === node.id && edge.source.handle === handle,
        );
        const id = `workflow-node-${node.id}-out-${handle}`;
        if (handle === fanOut) {
          return (
            <div key={handle} className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{wording.handle(handle)}</span>
              <ul className="flex flex-col gap-1">
                {edges.map((edge) => (
                  <li key={edge.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{name(edge.target.nodeId)}</span>
                    {readOnly ? null : (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('removeBranch', { target: name(edge.target.nodeId) })}
                        onClick={() => onGraphChange(removeEdges(graph, [edge.id]))}
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {readOnly ? null : (
                <ChoiceField
                  id={id}
                  label={t('addBranch')}
                  value={UNCONNECTED}
                  testId={`workflow-connect-${node.id}-${handle}`}
                  options={options.filter(
                    (option) =>
                      option.value === UNCONNECTED ||
                      !edges.some((edge) => edge.target.nodeId === option.value),
                  )}
                  onChange={(target) => {
                    if (target === UNCONNECTED) return;
                    const next = connect(graph, { source: node.id, handle, target });
                    if (next !== null) onGraphChange(next);
                  }}
                />
              )}
            </div>
          );
        }
        const current = edges[0]?.target.nodeId ?? UNCONNECTED;
        return (
          <ChoiceField
            key={handle}
            id={id}
            label={t('handleLeadsTo', { handle: wording.handle(handle) })}
            value={current}
            testId={`workflow-connect-${node.id}-${handle}`}
            options={options}
            onChange={(target) => {
              if (readOnly) return;
              if (target === UNCONNECTED) {
                onGraphChange(
                  removeEdges(
                    graph,
                    edges.map((edge) => edge.id),
                  ),
                );
                return;
              }
              const next = connect(graph, { source: node.id, handle, target });
              if (next !== null) onGraphChange(next);
            }}
          />
        );
      })}
    </section>
  );
}

export function EdgeInspector({
  edgeId,
  ...shared
}: Shared & {
  edgeId: string;
}) {
  const t = useTranslations('workflows.inspector');
  const wording = useWorkflowWording();
  const { graph, readOnly, onGraphChange } = shared;
  const edge = graph.edges.find((candidate) => candidate.id === edgeId);
  if (edge === undefined) return null;
  const own = shared.problems.filter((problem) => problem.edgeId === edge.id);
  return (
    <div className="flex flex-col gap-4" data-testid="workflow-edge-inspector">
      <h2 className="text-sm font-medium">{t('edgeTitle')}</h2>
      <p className="text-sm">
        {t('edgeDescription', {
          from: edge.source.nodeId,
          handle: wording.handle(edge.source.handle),
          to: edge.target.nodeId,
        })}
      </p>
      {own.length === 0 ? null : (
        <WorkflowProblemList
          problems={own}
          graph={graph}
          onSelect={shared.onSelectProblem}
          compact
        />
      )}
      {readOnly ? null : (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => onGraphChange(removeEdges(graph, [edge.id]))}
          data-testid="workflow-edge-delete"
        >
          <Trash2Icon className="size-4" />
          {t('deleteEdge')}
        </Button>
      )}
    </div>
  );
}

/** The workflow itself: its name, what it is for, and the limits every run is held to. */
export function WorkflowInspector({
  name,
  description,
  onNameChange,
  onDescriptionChange,
  envelope,
  onAddTrigger,
  ...shared
}: Shared & {
  name: string;
  description: string;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
  envelope: WorkflowEnvelope;
  onAddTrigger: () => void;
}) {
  const t = useTranslations('workflows.settings');
  const format = useRunFormat();
  const modeWording = useWorkflowWording();
  const { graph, readOnly, onGraphChange } = shared;
  const limits = graph.limits;
  const setLimit = (key: keyof typeof limits, value: number | null): void =>
    onGraphChange({ ...graph, limits: { ...limits, [key]: value } });

  return (
    <div className="flex flex-col gap-5" data-testid="workflow-settings">
      <fieldset disabled={readOnly} className="flex flex-col gap-4">
        <Field id="workflow-name" label={t('name')}>
          <Input
            id="workflow-name"
            value={name}
            maxLength={WORKFLOW_LIMITS.nameMaxChars}
            data-testid="workflow-name"
            onChange={(event) => onNameChange(event.target.value)}
          />
        </Field>
        <Field id="workflow-description" label={t('description')}>
          <Textarea
            id="workflow-description"
            value={description}
            rows={3}
            maxLength={WORKFLOW_LIMITS.descriptionMaxChars}
            onChange={(event) => onDescriptionChange(event.target.value)}
          />
        </Field>
      </fieldset>

      <section className="flex flex-col gap-3">
        <SectionRule as="h3">{t('limits')}</SectionRule>
        <p className="text-xs text-muted-foreground">{t('limitsHint')}</p>
        <fieldset disabled={readOnly} className="flex flex-col gap-3">
          <NumberField
            id="workflow-limit-steps"
            label={t('maxNodeExecutions')}
            value={limits.maxNodeExecutions}
            min={1}
            placeholder={t('inherit')}
            hint={t('effective', { value: format.count(envelope.limits.maxNodeExecutions) })}
            onChange={(value) => setLimit('maxNodeExecutions', value)}
          />
          <NumberField
            id="workflow-limit-parallel"
            label={t('maxParallelBranches')}
            value={limits.maxParallelBranches}
            min={1}
            placeholder={t('inherit')}
            hint={t('effective', { value: format.count(envelope.limits.maxParallelBranches) })}
            onChange={(value) => setLimit('maxParallelBranches', value)}
          />
          <NumberField
            id="workflow-limit-lifetime"
            label={t('maxLifetimeHours')}
            value={limits.maxLifetimeSeconds}
            scale={3_600}
            min={60}
            placeholder={t('inherit')}
            hint={t('effective', {
              value: t('hours', {
                count: Math.round(envelope.limits.maxLifetimeSeconds / 360) / 10,
              }),
            })}
            onChange={(value) => setLimit('maxLifetimeSeconds', value)}
          />
          <MoneyField
            id="workflow-limit-budget"
            label={t('budget')}
            value={limits.budgetMicroUsd}
            placeholder={t('inherit')}
            hint={t('effective', { value: format.money(envelope.limits.budgetMicroUsd) })}
            testId="workflow-limit-budget"
            onChange={(value) => setLimit('budgetMicroUsd', value)}
          />
        </fieldset>
      </section>

      <section className="flex flex-col gap-1.5" data-testid="workflow-envelope">
        <SectionRule as="h3">{t('envelope')}</SectionRule>
        <Readout
          label={t('workflowsEnabled')}
          value={envelope.workflowsEnabled ? t('on') : t('off')}
        />
        <Readout label={t('writeModeCeiling')} value={modeWording.writeMode(envelope.writeMode)} />
      </section>

      {graph.nodes.some((node) => node.type.startsWith('trigger.')) || readOnly ? null : (
        <Button variant="outline" size="sm" className="self-start" onClick={onAddTrigger}>
          <PlusIcon className="size-4" />
          {t('addTrigger')}
        </Button>
      )}
    </div>
  );
}
