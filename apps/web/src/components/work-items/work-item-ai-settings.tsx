'use client';

import { ChevronDownIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { AI_WRITE_MODES, type AiWriteMode, type WorkItemDetail } from '@exocortex/contracts';
import {
  cn,
  Label,
  sectionLabelClassName,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { WorkItemProfile } from '@/components/agent-profiles/work-item-profile';
import { useUpdateWorkItem } from '@/lib/api/work-item-queries';

const INHERIT = 'inherit';

/**
 * How the assistant may act on this work: its agent profile and its write
 * mode (issues #141, #143). Rarely changed, so folded away by default
 * (issue #182), with what is set named beside the toggle so nobody has to
 * open it to find out.
 */
export function WorkItemAiSettings({
  item,
  canWrite,
}: {
  item: WorkItemDetail;
  canWrite: boolean;
}) {
  const t = useTranslations('workItems.detail');
  const tProfile = useTranslations('agentProfiles.workItem');
  const tMode = useTranslations('changesets.workItem');
  const tSettings = useTranslations('settings.row.choices.writeMode');
  const [open, setOpen] = React.useState(false);
  const panelId = `work-item-ai-settings-${item.id}`;

  const profile = item.agentProfile?.name ?? tProfile('inheritNone');
  const mode = item.writeMode === null ? tMode('writeModeInherit') : tSettings(item.writeMode);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
        {/* The accordion pattern: the heading holds the button, never the
            other way round, because a button may only contain phrasing. */}
        <h2>
          <button
            type="button"
            // The rule's typography on a control: a disclosure is not a section
            // announcement, so it borrows the family look rather than the device
            // (the same call as the properties panel's technical section).
            className={cn(
              'flex min-h-6 items-center gap-2 rounded-sm transition-colors hover:text-foreground',
              sectionLabelClassName,
            )}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((next) => !next)}
            data-testid="work-item-ai-settings-toggle"
          >
            <ChevronDownIcon
              className={cn('size-3.5 transition-transform', open ? undefined : '-rotate-90')}
              aria-hidden
            />
            {t('aiSettingsHeading')}
            <span className="h-px w-6 shrink-0 bg-signal-line" aria-hidden />
          </button>
        </h2>
        <span
          className="text-meta text-muted-foreground"
          data-testid="work-item-ai-settings-summary"
        >
          {t('aiSettingsSummary', { profile, mode })}
        </span>
      </div>
      {open ? (
        <div id={panelId} className="grid gap-4 sm:grid-cols-2">
          <WorkItemProfile item={item} canWrite={canWrite} />
          <WriteModeSelect item={item} canWrite={canWrite} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * The mode is what produces proposals: a work item held to "propose" is one
 * whose changes arrive in its proposals instead of on the page.
 */
function WriteModeSelect({ item, canWrite }: { item: WorkItemDetail; canWrite: boolean }) {
  const t = useTranslations('changesets.workItem');
  const tSettings = useTranslations('settings.row.choices.writeMode');
  const update = useUpdateWorkItem(item.workspaceId);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={`write-mode-${item.id}`}>{t('writeModeLabel')}</Label>
      <Select
        value={item.writeMode ?? INHERIT}
        disabled={!canWrite || update.isPending}
        onValueChange={(value) =>
          update.mutate({
            workItemId: item.id,
            request: { writeMode: value === INHERIT ? null : (value as AiWriteMode) },
          })
        }
      >
        <SelectTrigger id={`write-mode-${item.id}`} data-testid="work-item-write-mode">
          <SelectValue>
            {() => (item.writeMode === null ? t('writeModeInherit') : tSettings(item.writeMode))}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT}>{t('writeModeInherit')}</SelectItem>
          {AI_WRITE_MODES.map((value) => (
            <SelectItem key={value} value={value}>
              {tSettings(value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-meta text-muted-foreground">{t('writeModeHelp')}</p>
      {update.error === null ? null : (
        <p className="text-sm text-destructive-text">{update.error.message}</p>
      )}
    </div>
  );
}
