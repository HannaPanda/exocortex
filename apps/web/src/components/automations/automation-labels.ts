import { useFormatter, useLocale, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AutomationAction,
  type AutomationOutput,
  type AutomationRunOrigin,
  type AutomationRunStatus,
  type AutomationScheduleKind,
  type AutomationScope,
  type AutomationTrigger,
} from '@exocortex/contracts';

/**
 * The words for the enums an automation is made of (issue #50, ADR-024).
 *
 * Their own file because three components need the same words: a list, a form
 * and a run log that disagreed about what `DOCUMENT_CONTENT_CHANGED` is called
 * would read like three different features. The words themselves live in the
 * `automations` catalogue; this file holds the orders and the one hook that
 * reads them.
 */

/** The order the form offers them in: from "happens most" to "happens least". */
export const TRIGGER_ORDER: readonly AutomationTrigger[] = [
  'DOCUMENT_CONTENT_CHANGED',
  'DOCUMENT_CREATED',
  'DOCUMENT_UPDATED',
  'DOCUMENT_MOVED',
  'DOCUMENT_ARCHIVED',
  'DOCUMENT_DELETED',
  'DATABASE_ROW_CHANGED',
  'SCHEDULE',
];

export const SCOPE_ORDER: readonly AutomationScope[] = ['WORKSPACE', 'SUBTREE', 'DATABASE'];

export const ACTION_ORDER: readonly AutomationAction[] = ['WEBHOOK', 'AI_RUN', 'EMAIL_SELF'];

export const OUTPUT_ORDER: readonly AutomationOutput[] = ['COMMENT', 'CHILD_PAGE'];

export const SCHEDULE_KIND_ORDER: readonly AutomationScheduleKind[] = [
  'ONCE',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'CRON',
];

/** Sunday first, the way `Date` counts, not the way a calendar prints. */
export const WEEKDAY_INDEXES: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

/** Badge colour per outcome. `SKIPPED` is deliberately not an error. */
export function runStatusVariant(
  status: AutomationRunStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'FAILED') return 'destructive';
  if (status === 'SUCCEEDED') return 'default';
  if (status === 'SKIPPED') return 'outline';
  return 'secondary';
}

export interface ScheduleDescription {
  scheduleKind: AutomationScheduleKind | null;
  scheduleAt: string | null;
  scheduleTime: string | null;
  scheduleWeekday: number | null;
  scheduleDayOfMonth: number | null;
  scheduleCron: string | null;
  scheduleTimeZone: string | null;
}

/**
 * Everything an automation says about itself, in the reader's language.
 *
 * Weekday names come from `Intl` with the active locale: 2023-01-01 was a
 * Sunday, so day `n` of that week is weekday `n` the way `Date` counts.
 */
export function useAutomationWording() {
  const t = useTranslations('automations');
  const format = useFormatter();
  const locale = useLocale();

  return React.useMemo(() => {
    const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
    const weekday = (index: number): string =>
      weekdayFormat.format(new Date(Date.UTC(2023, 0, 1 + index)));

    /** A timestamp in the local zone, without the year most rows share. */
    const moment = (iso: string): string =>
      format.dateTime(new Date(iso), {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });

    /** A duration a person can read at a glance. */
    const duration = (durationMs: number | null): string => {
      if (durationMs === null) return '';
      if (durationMs < 1_000)
        return format.number(durationMs, { style: 'unit', unit: 'millisecond' });
      return format.number(durationMs / 1_000, {
        style: 'unit',
        unit: 'second',
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
    };

    /**
     * A schedule in one clause (issue #73).
     *
     * The zone is always printed, even when it is the reader's own: a rule
     * that says 07:00 without saying where is a rule two people read
     * differently.
     */
    const schedule = (rule: ScheduleDescription): string => {
      const zone = rule.scheduleTimeZone ?? '?';
      const time = rule.scheduleTime ?? '?';
      switch (rule.scheduleKind) {
        case 'ONCE':
          return rule.scheduleAt === null
            ? t('schedule.once')
            : t('schedule.onceAt', { moment: moment(rule.scheduleAt) });
        case 'DAILY':
          return t('schedule.daily', { time, zone });
        case 'WEEKLY':
          return t('schedule.weekly', { weekday: weekday(rule.scheduleWeekday ?? 0), time, zone });
        case 'MONTHLY':
          return t('schedule.monthly', { day: rule.scheduleDayOfMonth ?? 1, time, zone });
        case 'CRON':
          return t('schedule.cron', { expression: rule.scheduleCron ?? '', zone });
        default:
          return t('schedule.none');
      }
    };

    return {
      trigger: (trigger: AutomationTrigger): string => t(`triggers.${trigger}`),
      scope: (scope: AutomationScope): string => t(`scopes.${scope}`),
      action: (action: AutomationAction): string => t(`actions.${action}`),
      output: (output: AutomationOutput): string => t(`outputs.${output}`),
      scheduleKind: (kind: AutomationScheduleKind): string => t(`scheduleKinds.${kind}`),
      runOrigin: (origin: AutomationRunOrigin): string => t(`runOrigins.${origin}`),
      runStatus: (status: AutomationRunStatus): string => t(`runStatuses.${status}`),
      weekday,
      moment,
      duration,
      schedule,
    };
  }, [format, locale, t]);
}
