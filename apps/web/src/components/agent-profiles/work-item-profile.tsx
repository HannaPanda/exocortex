'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { type WorkItemDetail } from '@exocortex/contracts';
import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useAgentProfiles } from '@/lib/api/agent-profile-queries';
import { useUpdateWorkItem } from '@/lib/api/work-item-queries';

const INHERIT = '__inherit__';

/**
 * Which agent profile a piece of work runs under (issue #143).
 *
 * Shown beside the write mode, because both say how the assistant may act on
 * this work. Choosing is a person's: the API refuses it from the assistant
 * and from a token that may not write.
 */
export function WorkItemProfile({ item, canWrite }: { item: WorkItemDetail; canWrite: boolean }) {
  const t = useTranslations('agentProfiles.workItem');
  const profiles = useAgentProfiles(item.workspaceId);
  const update = useUpdateWorkItem(item.workspaceId);
  const list = profiles.data?.profiles ?? [];
  const fallback = list.find((profile) => profile.isDefault) ?? null;
  const own = item.agentProfile !== null && !item.agentProfile.inherited ? item.agentProfile : null;
  const inheritLabel = fallback === null ? t('inheritNone') : t('inherit', { name: fallback.name });

  return (
    <div className="flex max-w-sm flex-col gap-1">
      <Label htmlFor={`agent-profile-${item.id}`}>{t('label')}</Label>
      <Select
        value={own?.id ?? INHERIT}
        disabled={!canWrite || update.isPending}
        onValueChange={(value) =>
          update.mutate({
            workItemId: item.id,
            request: { agentProfileId: value === INHERIT || value === null ? null : value },
          })
        }
      >
        <SelectTrigger id={`agent-profile-${item.id}`} data-testid="work-item-agent-profile">
          <SelectValue>{() => own?.name ?? inheritLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT}>{inheritLabel}</SelectItem>
          {list.map((profile) => (
            <SelectItem key={profile.id} value={profile.id}>
              {profile.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {t('help')}{' '}
        <Link
          href={`/arbeitsbereich/${item.workspaceId}/agentenprofile`}
          className="hover:underline"
        >
          {t('manage')}
        </Link>
      </p>
    </div>
  );
}
