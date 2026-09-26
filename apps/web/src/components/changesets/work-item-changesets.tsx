'use client';

import { useTranslations } from 'next-intl';

import { AI_WRITE_MODES, type AiWriteMode, type WorkItemDetail } from '@exocortex/contracts';
import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useChangesets } from '@/lib/api/changeset-queries';
import { useUpdateWorkItem } from '@/lib/api/work-item-queries';

import { Section } from '../work-items/work-item-sections';

import { ChangesetTable } from './changesets-page';

const INHERIT = 'inherit';

/**
 * What a piece of work proposed, and how its runs may write (issue #141).
 *
 * The mode sits beside the proposals because it is what produces them: a
 * work item held to "propose" is one whose changes arrive here instead of on
 * the page.
 */
export function WorkItemChangesets({
  item,
  canWrite,
}: {
  item: WorkItemDetail;
  canWrite: boolean;
}) {
  const t = useTranslations('changesets.workItem');
  const tSettings = useTranslations('settings.row.choices.writeMode');
  const list = useChangesets(item.workspaceId, { state: 'all', workItemId: item.id });
  const update = useUpdateWorkItem(item.workspaceId);
  const changesets = list.data?.changesets ?? [];

  return (
    <Section title={t('title')}>
      <div className="flex max-w-sm flex-col gap-1">
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
            {AI_WRITE_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {tSettings(mode)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t('writeModeHelp')}</p>
      </div>
      {changesets.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ChangesetTable workspaceId={item.workspaceId} changesets={changesets} />
      )}
    </Section>
  );
}
