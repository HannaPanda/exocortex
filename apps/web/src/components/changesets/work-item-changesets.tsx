'use client';

import { useTranslations } from 'next-intl';

import { type WorkItemDetail } from '@exocortex/contracts';

import { useChangesets } from '@/lib/api/changeset-queries';

import { Section } from '../work-items/work-item-sections';

import { ChangesetTable } from './changesets-page';

/**
 * What a piece of work proposed (issue #141). The write mode that produces
 * the proposals lives in the work item's AI settings (issue #182); this
 * section appears once there is something to decide, and not before.
 */
export function WorkItemChangesets({ item }: { item: WorkItemDetail }) {
  const t = useTranslations('changesets.workItem');
  const list = useChangesets(item.workspaceId, { state: 'all', workItemId: item.id });
  const changesets = list.data?.changesets ?? [];
  if (changesets.length === 0) return null;

  return (
    <Section title={t('title')} trailing={changesets.length}>
      <ChangesetTable workspaceId={item.workspaceId} changesets={changesets} />
    </Section>
  );
}
