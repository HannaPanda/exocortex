'use client';

import { useTranslations } from 'next-intl';

import {
  type AgentProfile,
  isTriggerNode,
  workflowAgentNodeEffect,
  type WorkflowEnvelope,
  type WorkflowGraph,
  type WorkflowResponse,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  LoadingState,
  Readout,
  SectionRule,
} from '@exocortex/ui';

import { useSetWorkflowActivation, useWorkflowVersion } from '@/lib/api/workflow-queries';

import { useRunFormat } from '../runs/run-inspector-format';

import { useWorkflowWording } from './workflow-labels';
import { useNodeSummary } from './workflow-summaries';

/**
 * Switching a workflow on or off (issue #164).
 *
 * Switching on is the moment a workflow starts to act without anybody
 * pressing anything, so the dialog reads the published version back before
 * it is confirmed: which triggers start it, which agent nodes it runs and how
 * freely they write, what one run may spend. It describes the version that
 * will run, never the draft beside it.
 */
export function WorkflowActivationDialog({
  open,
  enable,
  onOpenChange,
  workspaceId,
  response,
  profiles,
}: {
  open: boolean;
  enable: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  response: WorkflowResponse;
  profiles: readonly AgentProfile[];
}) {
  const t = useTranslations('workflows.activation');
  const { workflow, envelope } = response;
  const version = useWorkflowVersion(open && enable ? workflow.publishedVersion?.id : undefined);
  const activation = useSetWorkflowActivation(workspaceId, workflow.id);
  const graph = version.data?.version.graph;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{enable ? t('enableTitle') : t('disableTitle')}</DialogTitle>
          <DialogDescription>
            {enable
              ? t('enableDescription', { version: workflow.publishedVersion?.version ?? 0 })
              : t('disableDescription')}
          </DialogDescription>
        </DialogHeader>
        {enable ? (
          <DialogBody>
            {graph === undefined ? (
              <LoadingState variant="skeleton" rows={3} label={t('loading')} />
            ) : (
              <ActivationSummary graph={graph} envelope={envelope} profiles={profiles} />
            )}
          </DialogBody>
        ) : null}
        {activation.error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{activation.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            disabled={activation.isPending || (enable && graph === undefined)}
            data-testid="workflow-activation-confirm"
            onClick={() => activation.mutate(enable, { onSuccess: () => onOpenChange(false) })}
          >
            {enable ? t('enable') : t('disable')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What switching on will set going: triggers, agents and their envelope, limits. */
function ActivationSummary({
  graph,
  envelope,
  profiles,
}: {
  graph: WorkflowGraph;
  envelope: WorkflowEnvelope;
  profiles: readonly AgentProfile[];
}) {
  const t = useTranslations('workflows.activation');
  const wording = useWorkflowWording();
  const format = useRunFormat();
  const summary = useNodeSummary([]);
  const triggers = graph.nodes.filter(isTriggerNode);
  const agents = graph.nodes.flatMap((node) => (node.type === 'agent' ? [node] : []));
  const unattended = triggers.some((node) => node.type !== 'trigger.manual');
  return (
    <div className="flex flex-col gap-4" data-testid="workflow-activation-summary">
      {unattended ? null : (
        <Alert>
          <AlertDescription>{t('manualOnly')}</AlertDescription>
        </Alert>
      )}
      <section className="flex flex-col gap-1.5">
        <SectionRule as="h3">{t('triggers')}</SectionRule>
        <ul className="flex flex-col gap-1 text-sm">
          {triggers.map((node) => (
            <li key={node.id}>
              <span className="font-medium">{wording.type(node.type)}</span>
              {' · '}
              <span className="text-muted-foreground">{summary(node, graph)}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-1.5">
        <SectionRule as="h3">{t('agents', { count: agents.length })}</SectionRule>
        {agents.map((node) => {
          const effect = workflowAgentNodeEffect({ node, envelope, profiles });
          return (
            <Readout
              key={node.id}
              label={node.label ?? node.id}
              value={wording.writeMode(effect.writeMode)}
              note={t('agentNote', {
                profile: effect.profile?.name ?? t('noProfile'),
                budget: format.money(effect.budgetMicroUsd),
              })}
            />
          );
        })}
      </section>
      <section className="flex flex-col gap-1.5">
        <SectionRule as="h3">{t('limits')}</SectionRule>
        <Readout label={t('budget')} value={format.money(envelope.limits.budgetMicroUsd)} />
        <Readout label={t('steps')} value={format.count(envelope.limits.maxNodeExecutions)} />
      </section>
      {envelope.workflowsEnabled ? null : (
        <Alert>
          <AlertDescription>{t('workflowsOff')}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
