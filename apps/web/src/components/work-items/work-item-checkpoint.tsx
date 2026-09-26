'use client';

import { CheckIcon, CircleDotIcon, CircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type WorkCheckpoint,
  type WorkCheckpointRef,
  type WorkCheckpointStep,
  type WorkItemDetail,
} from '@exocortex/contracts';
import { Badge, Button } from '@exocortex/ui';

import { useWorkItemCheckpoints } from '@/lib/api/work-item-queries';

import { useWorkItemWording } from './work-item-labels';
import { Section } from './work-item-sections';

/**
 * Where the work stands (issue #142, ADR-069).
 *
 * The newest checkpoint is the state and is shown whole; the older ones are
 * how the work got there and fold away. Read-only: a person changes the work
 * by answering, editing or starting a run, and the worker records the state.
 */
export function CheckpointSection({ item }: { item: WorkItemDetail }) {
  const t = useTranslations('workItems.checkpoint');
  const query = useWorkItemCheckpoints(item.id, item.checkpointCount > 0);
  const [showEarlier, setShowEarlier] = React.useState(false);

  if (item.checkpointCount === 0) {
    return (
      <Section title={t('heading')}>
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      </Section>
    );
  }
  if (query.isPending) {
    return (
      <Section title={t('heading')}>
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      </Section>
    );
  }
  if (query.isError) {
    return (
      <Section title={t('heading')}>
        <p className="text-sm text-destructive-text">{t('loadFailed')}</p>
      </Section>
    );
  }

  const [latest, ...earlier] = query.data.checkpoints;
  if (latest === undefined) return null;
  return (
    <Section
      title={t('heading')}
      action={
        earlier.length === 0 ? null : (
          <Button size="sm" variant="ghost" onClick={() => setShowEarlier((shown) => !shown)}>
            {showEarlier ? t('hideEarlier') : t('showEarlier', { count: query.data.total - 1 })}
          </Button>
        )
      }
    >
      <div data-testid="work-item-checkpoint">
        <CheckpointView workspaceId={item.workspaceId} checkpoint={latest} />
      </div>
      {showEarlier ? (
        <ol className="flex flex-col gap-4 border-l border-border pl-4">
          {earlier.map((checkpoint) => (
            <li key={checkpoint.id}>
              <CheckpointView workspaceId={item.workspaceId} checkpoint={checkpoint} />
            </li>
          ))}
        </ol>
      ) : null}
    </Section>
  );
}

function CheckpointView({
  workspaceId,
  checkpoint,
}: {
  workspaceId: string;
  checkpoint: WorkCheckpoint;
}) {
  const t = useTranslations('workItems.checkpoint');
  const labels = useTranslations('workItems.labels');
  const wording = useWorkItemWording();
  const artifacts = checkpoint.refs.filter((ref) => ref.role === 'artifact');
  const sources = checkpoint.refs.filter((ref) => ref.role === 'source');

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={checkpoint.trigger === 'run_interrupted' ? 'destructive' : 'secondary'}>
          {labels(`trigger.${checkpoint.trigger}`)}
        </Badge>
        <span>
          {checkpoint.system ? t('bySystem') : wording.participant(checkpoint.author)}
          {' · '}
          {wording.moment(checkpoint.createdAt)}
        </span>
        {checkpoint.model === null ? null : <span>{t('model', { model: checkpoint.model })}</span>}
      </div>

      {checkpoint.summary.length === 0 ? null : (
        <p className="whitespace-pre-wrap">{checkpoint.summary}</p>
      )}
      {checkpoint.interruptionCode === null ? null : (
        <p className="text-muted-foreground">
          {t('interrupted', { code: checkpoint.interruptionCode })}
        </p>
      )}

      {checkpoint.plan.length === 0 ? null : (
        <Part title={t('planHeading')}>
          <ul className="flex flex-col gap-1">
            {checkpoint.plan.map((step, index) => (
              <PlanStep key={index} step={step} />
            ))}
          </ul>
        </Part>
      )}
      <Notes title={t('findingsHeading')} lines={checkpoint.findings} />
      <Notes title={t('assumptionsHeading')} lines={checkpoint.assumptions} />
      {checkpoint.lastAction === null ? null : (
        <p>
          <span className="text-muted-foreground">{t('lastAction')}</span> {checkpoint.lastAction}
        </p>
      )}
      {checkpoint.nextStep === null ? null : (
        <p>
          <span className="text-muted-foreground">{t('nextStep')}</span> {checkpoint.nextStep}
        </p>
      )}
      <Pages title={t('artifactsHeading')} workspaceId={workspaceId} refs={artifacts} />
      <Pages title={t('sourcesHeading')} workspaceId={workspaceId} refs={sources} />

      {checkpoint.pendingDecisions.length === 0 ? null : (
        <Part title={t('pendingHeading')}>
          <ul className="flex flex-col gap-1">
            {checkpoint.pendingDecisions.map((decision) => (
              <li key={decision.attentionItemId} className="flex flex-wrap items-center gap-2">
                <span>{decision.title}</span>
                <Badge variant={decision.status === 'open' ? 'outline' : 'muted'}>
                  {t(`decision.${decision.status}`)}
                </Badge>
              </li>
            ))}
          </ul>
        </Part>
      )}
      {checkpoint.budgetMicroUsd === null ? null : (
        <p className="text-xs text-muted-foreground">
          {t('budget', {
            spent: wording.money(checkpoint.spentMicroUsd),
            budget: wording.money(checkpoint.budgetMicroUsd),
          })}
        </p>
      )}
    </div>
  );
}

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function PlanStep({ step }: { step: WorkCheckpointStep }) {
  const t = useTranslations('workItems.checkpoint');
  const Icon =
    step.status === 'done' ? CheckIcon : step.status === 'in_progress' ? CircleDotIcon : CircleIcon;
  return (
    <li className="flex items-start gap-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className={step.status === 'done' ? 'text-muted-foreground line-through' : undefined}>
        <span className="sr-only">{t(`step.${step.status}`)}: </span>
        {step.text}
      </span>
    </li>
  );
}

function Notes({ title, lines }: { title: string; lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <Part title={title}>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    </Part>
  );
}

function Pages({
  title,
  workspaceId,
  refs,
}: {
  title: string;
  workspaceId: string;
  refs: readonly WorkCheckpointRef[];
}) {
  const t = useTranslations('workItems.checkpoint');
  if (refs.length === 0) return null;
  return (
    <Part title={title}>
      <ul className="flex flex-col gap-1">
        {refs.map((ref) => (
          <li key={`${ref.role}:${ref.documentId}`} className="flex flex-wrap items-center gap-2">
            {ref.title === null ? (
              <span className="text-muted-foreground">{t('deleted')}</span>
            ) : (
              <Link
                href={`/arbeitsbereich/${workspaceId}/seite/${ref.documentId}`}
                className="hover:underline"
              >
                {ref.title}
              </Link>
            )}
            {ref.changedSince ? <Badge variant="outline">{t('changedSince')}</Badge> : null}
          </li>
        ))}
      </ul>
    </Part>
  );
}
