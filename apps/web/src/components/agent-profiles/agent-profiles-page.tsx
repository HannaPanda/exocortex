'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AgentProfile } from '@exocortex/contracts';
import {
  AppPage,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { useAgentProfiles } from '@/lib/api/agent-profile-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { useWorkItemWording } from '../work-items/work-item-labels';

import { AgentProfileDialog } from './agent-profile-dialog';
import { useAgentProfileWording } from './agent-profile-labels';

/**
 * The agent profiles of one workspace (issue #143, ADR-071).
 *
 * The table answers "which roles are there and how tight is each": how it
 * may write, how much of the catalogue it gets, which model it prefers and
 * what a piece of work may cost under it. The default stands first.
 */
export function AgentProfilesPage({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('agentProfiles.list');
  const workspace = useWorkspaceDetail(workspaceId);
  const list = useAgentProfiles(workspaceId);
  const [creating, setCreating] = React.useState(false);
  const role = workspace.data?.role ?? null;
  const canManage = role === 'OWNER' || role === 'ADMIN';

  return (
    <AppPage maxWidth="max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="exocortex-page-title">{t('title')}</h1>
          <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>
          <Link
            href={`/arbeitsbereich/${workspaceId}/auftraege`}
            className="mt-2 inline-block text-sm hover:underline"
          >
            {t('workItemsLink')}
          </Link>
        </div>
        {canManage ? (
          <Button onClick={() => setCreating(true)} data-testid="agent-profile-new">
            {t('newProfile')}
          </Button>
        ) : null}
      </div>
      {canManage || workspace.isPending ? null : (
        <p className="mt-3 text-xs text-muted-foreground">{t('adminOnly')}</p>
      )}

      <section className="mt-6">
        {list.isPending ? (
          <LoadingState variant="skeleton" rows={3} label={t('loading')} />
        ) : list.isError ? (
          <ErrorState title={t('loadFailed')} onRetry={() => void list.refetch()} />
        ) : list.data.profiles.length === 0 ? (
          <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
        ) : (
          <ProfileTable workspaceId={workspaceId} profiles={list.data.profiles} />
        )}
      </section>

      <AgentProfileDialog
        open={creating}
        onOpenChange={setCreating}
        workspaceId={workspaceId}
        profile={null}
      />
    </AppPage>
  );
}

function ProfileTable({
  workspaceId,
  profiles,
}: {
  workspaceId: string;
  profiles: readonly AgentProfile[];
}) {
  const t = useTranslations('agentProfiles.list');
  const tDetail = useTranslations('agentProfiles.detail');
  const wording = useAgentProfileWording();
  const money = useWorkItemWording().money;
  return (
    <Table narrow="list" data-testid="agent-profiles">
      <TableHeader>
        <TableRow>
          <TableHead>{t('columns.name')}</TableHead>
          <TableHead>{t('columns.writeMode')}</TableHead>
          <TableHead>{t('columns.tools')}</TableHead>
          <TableHead>{t('columns.model')}</TableHead>
          <TableHead>{t('columns.budget')}</TableHead>
          <TableHead>{t('columns.workItems')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {profiles.map((profile) => (
          <TableRow key={profile.id} data-testid="agent-profile-row">
            <TableCell cell="title">
              <Link
                href={`/arbeitsbereich/${workspaceId}/agentenprofile/${profile.id}`}
                className="font-medium hover:underline"
              >
                {profile.name}
              </Link>
              {profile.isDefault ? (
                <Badge variant="secondary" className="ml-2">
                  {t('defaultBadge')}
                </Badge>
              ) : null}
              {profile.description === null ? null : (
                <div className="text-xs text-muted-foreground">{profile.description}</div>
              )}
            </TableCell>
            <TableCell label={t('columns.writeMode')} className="text-sm">
              {wording.writeMode(profile.writeMode)}
            </TableCell>
            <TableCell label={t('columns.tools')} className="text-sm text-muted-foreground">
              {profile.toolDomains === null
                ? t('toolsAll')
                : t('toolsCount', { count: profile.toolDomains.length + 1 })}
            </TableCell>
            <TableCell label={t('columns.model')} className="text-sm text-muted-foreground">
              {profile.modelSlug ?? tDetail('modelDefault')}
            </TableCell>
            <TableCell label={t('columns.budget')} className="text-sm text-muted-foreground">
              {profile.budgetMicroUsdPerTask === null
                ? tDetail('unlimited')
                : money(profile.budgetMicroUsdPerTask)}
            </TableCell>
            <TableCell label={t('columns.workItems')} className="text-sm text-muted-foreground">
              {profile.workItemCount}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
