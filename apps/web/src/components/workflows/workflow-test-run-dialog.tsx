'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  AI_WRITE_MODES,
  type AiWriteMode,
  isTriggerNode,
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
  Textarea,
} from '@exocortex/ui';

import { useStartWorkflowRun, useWorkflowVersion } from '@/lib/api/workflow-queries';

import { useAgentProfileWording } from '../agent-profiles/agent-profile-labels';

import { ChoiceField, Field } from './workflow-fields';
import { useWorkflowWording } from './workflow-labels';

/**
 * A test run (issue #164): the published version, on the real runtime, from
 * any of its triggers, with agent nodes that propose instead of writing.
 *
 * A test is not a simulation. It creates real work items and runs the real
 * assistant, which costs money and, if allowed, changes pages; so the
 * cautious envelope is the default and loosening it is a separate, visible
 * choice with a warning beside it.
 */
export function WorkflowTestRunDialog({
  open,
  onOpenChange,
  workspaceId,
  response,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  response: WorkflowResponse;
}) {
  const t = useTranslations('workflows.test');
  const wording = useWorkflowWording();
  const profileWording = useAgentProfileWording();
  const router = useRouter();
  const { workflow, envelope } = response;
  const version = useWorkflowVersion(open ? workflow.publishedVersion?.id : undefined);
  const start = useStartWorkflowRun(workflow.id);
  const triggers = (version.data?.version.graph.nodes ?? []).filter(isTriggerNode);

  const [triggerId, setTriggerId] = React.useState('');
  const [writeMode, setWriteMode] = React.useState<AiWriteMode>('propose');
  const [input, setInput] = React.useState('');
  const chosenTrigger = triggerId.length > 0 ? triggerId : (triggers[0]?.id ?? '');

  const parsedInput = React.useMemo((): Record<string, unknown> | null | 'invalid' => {
    if (input.trim().length === 0) return null;
    try {
      const value: unknown = JSON.parse(input);
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : 'invalid';
    } catch {
      return 'invalid';
    }
  }, [input]);

  const submit = async (): Promise<void> => {
    if (parsedInput === 'invalid') return;
    const started = await start.mutateAsync({
      test: true,
      writeMode,
      ...(chosenTrigger.length === 0 ? {} : { triggerNodeId: chosenTrigger }),
      ...(parsedInput === null ? {} : { input: parsedInput }),
    });
    onOpenChange(false);
    router.push(`/arbeitsbereich/${workspaceId}/workflows/${workflow.id}/laeufe/${started.run.id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description', { version: workflow.publishedVersion?.version ?? 0 })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {version.isPending ? (
            <LoadingState variant="skeleton" rows={3} label={t('loading')} />
          ) : (
            <div className="flex flex-col gap-4" data-testid="workflow-test-form">
              {workflow.hasUnpublishedChanges ? (
                <Alert>
                  <AlertDescription>{t('draftNotTested')}</AlertDescription>
                </Alert>
              ) : null}
              {!envelope.workflowsEnabled ? (
                <Alert variant="destructive">
                  <AlertDescription>{t('workflowsOff')}</AlertDescription>
                </Alert>
              ) : null}
              <ChoiceField
                id="workflow-test-trigger"
                label={t('trigger')}
                value={chosenTrigger}
                options={triggers.map((node) => ({
                  value: node.id,
                  label: `${node.label ?? node.id} (${wording.type(node.type)})`,
                }))}
                onChange={setTriggerId}
              />
              <ChoiceField<AiWriteMode>
                id="workflow-test-write-mode"
                label={t('writeMode')}
                hint={t(`writeModeHint.${writeMode}`)}
                value={writeMode}
                testId="workflow-test-write-mode"
                options={AI_WRITE_MODES.map((mode) => ({
                  value: mode,
                  label: profileWording.writeMode(mode),
                }))}
                onChange={setWriteMode}
              />
              {writeMode === 'direct' ? (
                <Alert variant="destructive" data-testid="workflow-test-direct-warning">
                  <AlertDescription>{t('directWarning')}</AlertDescription>
                </Alert>
              ) : null}
              <Field id="workflow-test-input" label={t('input')} hint={t('inputHint')}>
                <Textarea
                  id="workflow-test-input"
                  value={input}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder='{"documentId": "…"}'
                  aria-invalid={parsedInput === 'invalid'}
                  onChange={(event) => setInput(event.target.value)}
                />
              </Field>
            </div>
          )}
        </DialogBody>
        {start.error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{start.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            disabled={
              start.isPending ||
              parsedInput === 'invalid' ||
              chosenTrigger.length === 0 ||
              !envelope.workflowsEnabled
            }
            onClick={() => void submit()}
            data-testid="workflow-test-start"
          >
            {t('start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
