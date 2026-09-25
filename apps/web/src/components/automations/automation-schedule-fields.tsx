'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AutomationScheduleKind } from '@exocortex/contracts';
import {
  DateTimePicker,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { SCHEDULE_KIND_ORDER, useAutomationWording, WEEKDAY_INDEXES } from './automation-labels';

/**
 * The clock half of a rule (issue #73).
 *
 * Its own file rather than a fifth block in the dialog: five kinds with
 * different fields is the one part of writing a rule that needs room, and the
 * dialog was already at the length where a reader stops finding things.
 *
 * The zone is a plain text field with the browser's own zone prefilled. A
 * searchable picker over four hundred IANA names would be a component to
 * maintain for a value almost nobody changes, and the API refuses a name the
 * runtime does not know, so a typo is caught rather than stored.
 */
export interface ScheduleDraft {
  scheduleKind: AutomationScheduleKind;
  /** `datetime-local` value: `YYYY-MM-DDTHH:MM`, read in the browser's zone. */
  scheduleAt: string;
  scheduleTime: string;
  scheduleWeekday: number;
  scheduleDayOfMonth: number;
  scheduleCron: string;
  scheduleTimeZone: string;
}

export function AutomationScheduleFields({
  draft,
  onChange,
}: {
  draft: ScheduleDraft;
  /**
   * A patch rather than a `(field, value)` setter: the dialog's own setter is
   * generic over its wider draft, and TypeScript refuses to see the two generic
   * signatures as the same function. A patch has no type parameter to disagree
   * about.
   */
  onChange: (patch: Partial<ScheduleDraft>) => void;
}) {
  const t = useTranslations('automations.scheduleFields');
  const wording = useAutomationWording();
  const kind = draft.scheduleKind;
  return (
    <div className="flex flex-col gap-4" data-testid="automation-schedule">
      <div className="flex flex-col gap-2">
        <Label>{t('kind')}</Label>
        <Select
          value={kind}
          onValueChange={(value) => onChange({ scheduleKind: value as AutomationScheduleKind })}
        >
          <SelectTrigger data-testid="automation-schedule-kind">
            <SelectValue>{() => wording.scheduleKind(kind)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_KIND_ORDER.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {wording.scheduleKind(entry)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {kind === 'ONCE' ? (
        <div className="flex flex-col gap-2">
          <Label id="automation-schedule-at-label">{t('at')}</Label>
          <DateTimePicker
            aria-labelledby="automation-schedule-at-label"
            data-testid="automation-schedule-at"
            value={draft.scheduleAt.length === 0 ? null : draft.scheduleAt}
            onChange={(value) => onChange({ scheduleAt: value ?? '' })}
          />
          <p className="text-xs text-muted-foreground">{t('atHint')}</p>
        </div>
      ) : null}

      {kind === 'WEEKLY' ? (
        <div className="flex flex-col gap-2">
          <Label>{t('weekday')}</Label>
          <Select
            value={String(draft.scheduleWeekday)}
            onValueChange={(value) => onChange({ scheduleWeekday: Number(value) })}
          >
            <SelectTrigger data-testid="automation-schedule-weekday">
              <SelectValue>{() => wording.weekday(draft.scheduleWeekday)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {WEEKDAY_INDEXES.map((index) => (
                <SelectItem key={index} value={String(index)}>
                  {wording.weekday(index)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {kind === 'MONTHLY' ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="automation-schedule-day">{t('dayOfMonth')}</Label>
          <Input
            id="automation-schedule-day"
            data-testid="automation-schedule-day"
            type="number"
            min={1}
            max={31}
            value={draft.scheduleDayOfMonth}
            onChange={(event) => onChange({ scheduleDayOfMonth: Number(event.target.value) })}
            className="max-w-24"
          />
          <p className="text-xs text-muted-foreground">{t('dayOfMonthHint')}</p>
        </div>
      ) : null}

      {kind === 'DAILY' || kind === 'WEEKLY' || kind === 'MONTHLY' ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="automation-schedule-time">{t('time')}</Label>
          <Input
            id="automation-schedule-time"
            data-testid="automation-schedule-time"
            type="time"
            value={draft.scheduleTime}
            onChange={(event) => onChange({ scheduleTime: event.target.value })}
            className="max-w-32"
          />
        </div>
      ) : null}

      {kind === 'CRON' ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="automation-schedule-cron">{t('cron')}</Label>
          <Input
            id="automation-schedule-cron"
            data-testid="automation-schedule-cron"
            value={draft.scheduleCron}
            onChange={(event) => onChange({ scheduleCron: event.target.value })}
            placeholder="0 7 * * 1"
          />
          <p className="text-xs text-muted-foreground">{t('cronHint')}</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="automation-schedule-zone">{t('zone')}</Label>
        <Input
          id="automation-schedule-zone"
          data-testid="automation-schedule-zone"
          value={draft.scheduleTimeZone}
          onChange={(event) => onChange({ scheduleTimeZone: event.target.value })}
          placeholder="Europe/Berlin"
          className="max-w-60"
        />
        <p className="text-xs text-muted-foreground">{t('zoneHint')}</p>
      </div>
    </div>
  );
}

/** The browser's own zone, which is the right guess for a rule somebody writes here. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
  } catch {
    return 'Europe/Berlin';
  }
}

/** An ISO instant as the value a `datetime-local` input wants. */
export function toLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(moment.getFullYear())}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}T${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
}

/** A `datetime-local` value as the absolute instant the API stores. */
export function fromLocalInput(value: string): string | null {
  if (value.trim().length === 0) return null;
  const moment = new Date(value);
  return Number.isNaN(moment.getTime()) ? null : moment.toISOString();
}
