'use client';

import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  workCheckpointTriggerSchema,
  type WorkItemEvent,
  type WorkItemParticipant,
  type WorkItemPriority,
  type WorkItemStatus,
} from '@exocortex/contracts';

/**
 * The words the work item screens share (issue #138).
 *
 * One hook so the list, the detail and the dialog cannot name the same
 * status two ways. The status badge colour is chosen here too: destructive
 * for what failed, muted for what is closed otherwise, outline for what waits
 * on somebody, the default for work in progress.
 */
export function statusVariant(
  status: WorkItemStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' | 'muted' {
  switch (status) {
    case 'failed':
      return 'destructive';
    case 'done':
    case 'cancelled':
      return 'muted';
    case 'blocked':
    case 'waiting_for_human':
    case 'review':
      return 'outline';
    case 'working':
      return 'default';
    case 'queued':
      return 'secondary';
  }
}

export function useWorkItemWording() {
  const t = useTranslations('workItems.labels');
  const format = useFormatter();

  return React.useMemo(() => {
    const status = (value: WorkItemStatus): string => t(`status.${value}`);
    const priority = (value: WorkItemPriority): string => t(`priority.${value}`);

    const participant = (value: WorkItemParticipant | null): string => {
      if (value === null) return t('participant.nobody');
      if (value.kind === 'assistant') return t('participant.assistant');
      const name = value.name ?? t('participant.unknown');
      return value.kind === 'agent' ? t('participant.agent', { name }) : name;
    };

    const moment = (iso: string): string =>
      format.dateTime(new Date(iso), {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

    const day = (iso: string): string =>
      format.dateTime(new Date(iso), { day: '2-digit', month: '2-digit', year: 'numeric' });

    /** Millionths of a dollar, as a person reads money. */
    const money = (microUsd: number): string =>
      format.number(microUsd / 1_000_000, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 4,
      });

    /** One history line, in words. The note itself is shown beside it. */
    const event = (value: WorkItemEvent): string => {
      switch (value.kind) {
        case 'created':
          return t('event.created');
        case 'status_changed':
          return t('event.statusChanged', {
            from: value.data.from === undefined ? '' : status(value.data.from),
            to: value.data.to === undefined ? '' : status(value.data.to),
          });
        case 'assigned':
          return t('event.assigned', { assignee: participant(value.data.assignee ?? null) });
        case 'run_started':
          return value.data.checkpointId === undefined
            ? t('event.runStarted')
            : t('event.runStartedFromCheckpoint');
        case 'result_recorded':
          return t('event.resultRecorded');
        case 'note':
          return t('event.note');
        case 'updated':
          return t('event.updated', { count: value.data.fields?.length ?? 0 });
        case 'attention_raised':
          return t('event.attentionRaised');
        case 'attention_resolved':
          return t('event.attentionResolved');
        case 'run_resumed':
          return t('event.runResumed');
        case 'resume_failed':
          return t('event.resumeFailed', { code: value.data.reason ?? '' });
        case 'checkpoint_recorded':
          return t('event.checkpointRecorded', {
            trigger: t(
              `trigger.${workCheckpointTriggerSchema.catch('step').parse(value.data.trigger)}`,
            ),
          });
      }
    };

    return { status, priority, participant, moment, day, money, event };
  }, [format, t]);
}
