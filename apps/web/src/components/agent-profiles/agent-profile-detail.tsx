'use client';

import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AgentProfile, type AgentProfileHistoryEntry } from '@exocortex/contracts';
import {
  AppPage,
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  Input,
  Label,
  LoadingState,
} from '@exocortex/ui';

import { useDurationWords } from '@/components/duration-input';
import {
  useAgentProfile,
  useDeleteAgentProfile,
  useDuplicateAgentProfile,
  useUpdateAgentProfile,
} from '@/lib/api/agent-profile-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { useWorkItemWording } from '../work-items/work-item-labels';
import { Section } from '../work-items/work-item-sections';

import { AgentProfileDialog } from './agent-profile-dialog';
import { useAgentProfileWording } from './agent-profile-labels';

/**
 * One agent profile (issue #143, ADR-071).
 *
 * Read top to bottom the way a person checks a role before handing work to
 * it: what it is told, which model and provider, which tools, how it may
 * write and close, what it may spend. The three layers -- profile, model,
 * provider -- are said apart once, at the place where they meet.
 */
export function AgentProfileDetail({
  workspaceId,
  profileId,
}: {
  workspaceId: string;
  profileId: string;
}) {
  const t = useTranslations('agentProfiles.detail');
  const query = useAgentProfile(profileId);
  const workspace = useWorkspaceDetail(workspaceId);

  if (query.isPending) return <LoadingState variant="skeleton" rows={6} label={t('loading')} />;
  if (query.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void query.refetch()} />;
  }
  const role = workspace.data?.role ?? null;
  return (
    <ProfileView
      profile={query.data.profile}
      history={query.data.history}
      canManage={role === 'OWNER' || role === 'ADMIN'}
    />
  );
}

function ProfileView({
  profile,
  history,
  canManage,
}: {
  profile: AgentProfile;
  history: readonly AgentProfileHistoryEntry[];
  canManage: boolean;
}) {
  const t = useTranslations('agentProfiles.detail');
  const duration = useDurationWords();
  const wording = useAgentProfileWording();
  const money = useWorkItemWording().money;
  const update = useUpdateAgentProfile(profile.workspaceId);
  const [editing, setEditing] = React.useState(false);
  const [duplicating, setDuplicating] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const limit = (microUsd: number | null): string =>
    microUsd === null ? t('unlimited') : money(microUsd);

  return (
    <AppPage maxWidth="max-w-3xl" className="flex flex-col gap-5">
      <Link
        href={`/arbeitsbereich/${profile.workspaceId}/agentenprofile`}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {t('back')}
      </Link>

      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-4">
          <h1 className="exocortex-page-title" data-testid="agent-profile-heading">
            {profile.name}
          </h1>
          {canManage ? (
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                {t('edit')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setDuplicating(true)}>
                {t('duplicate')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate({
                    profileId: profile.id,
                    request: { isDefault: !profile.isDefault },
                  })
                }
                data-testid="agent-profile-toggle-default"
              >
                {profile.isDefault ? t('removeDefault') : t('makeDefault')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDeleting(true)}>
                {t('delete')}
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">{t('revision', { revision: profile.revision })}</Badge>
          {profile.isDefault ? <Badge variant="secondary">{t('defaultHint')}</Badge> : null}
          <span>{t('openWorkItems', { count: profile.workItemCount })}</span>
        </div>
        {profile.description === null ? null : <p className="text-sm">{profile.description}</p>}
      </div>

      <Section title={t('sections.role')}>
        <p className="text-sm whitespace-pre-wrap">{profile.instructions ?? t('roleEmpty')}</p>
        {profile.ruleDocuments.length === 0 ? null : (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('rulesLabel')}</span>
            <ul className="flex flex-col gap-1 text-sm">
              {profile.ruleDocuments.map((rule) => (
                <li key={rule.documentId}>
                  {rule.title === null ? (
                    <span className="text-muted-foreground">{t('ruleGone')}</span>
                  ) : (
                    <Link
                      href={`/arbeitsbereich/${profile.workspaceId}/seite/${rule.documentId}`}
                      className="hover:underline"
                    >
                      {rule.title}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title={t('sections.model')}>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{t('modelLabel')}</dt>
          <dd>{profile.modelSlug ?? t('modelDefault')}</dd>
          <dt className="text-muted-foreground">{t('reasoningLabel')}</dt>
          <dd>
            {profile.reasoningLevel === null
              ? t('reasoningDefault')
              : wording.reasoning(profile.reasoningLevel)}
          </dd>
          <dt className="text-muted-foreground">{t('routingLabel')}</dt>
          <dd className="font-mono text-xs">
            {profile.providerRouting === null
              ? t('routingNone')
              : JSON.stringify(profile.providerRouting)}
          </dd>
        </dl>
        <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">{t('layers.title')}</p>
          <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
            <li>{t('layers.profile')}</li>
            <li>{t('layers.model')}</li>
            <li>{t('layers.provider')}</li>
          </ul>
        </div>
      </Section>

      <Section title={t('sections.tools')}>
        {profile.toolDomains === null ? (
          <p className="text-sm">{t('toolsAll')}</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" data-testid="agent-profile-tool-domains">
            {['core' as const, ...profile.toolDomains.filter((domain) => domain !== 'core')].map(
              (domain) => (
                <li key={domain}>
                  <Badge variant="outline">{wording.domain(domain)}</Badge>
                </li>
              ),
            )}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t('toolsAlways')}</p>
      </Section>

      <Section title={t('sections.policy')}>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{t('writeModeLabel')}</dt>
          <dd data-testid="agent-profile-write-mode-value">
            {wording.writeMode(profile.writeMode)}
          </dd>
          <dt className="text-muted-foreground">{t('approvalLabel')}</dt>
          <dd>{wording.approval(profile.approvalPolicy)}</dd>
          <dt className="text-muted-foreground">{t('confineLabel')}</dt>
          <dd>{profile.confineToWorkspace ? t('confineYes') : t('confineNo')}</dd>
        </dl>
      </Section>

      <Section title={t('sections.limits')}>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{t('budgetRunLabel')}</dt>
          <dd>{limit(profile.budgetMicroUsdPerRun)}</dd>
          <dt className="text-muted-foreground">{t('budgetTaskLabel')}</dt>
          <dd>{limit(profile.budgetMicroUsdPerTask)}</dd>
          <dt className="text-muted-foreground">{t('iterationsLabel')}</dt>
          <dd>{profile.maxToolIterations ?? t('unlimited')}</dd>
          <dt className="text-muted-foreground">{t('runSecondsLabel')}</dt>
          <dd>
            {profile.maxRunSeconds === null
              ? t('unlimited')
              : duration(profile.maxRunSeconds, 'seconds')}
          </dd>
        </dl>
      </Section>

      <HistorySection history={history} />

      <AgentProfileDialog
        open={editing}
        onOpenChange={setEditing}
        workspaceId={profile.workspaceId}
        profile={profile}
      />
      <DuplicateDialog profile={profile} open={duplicating} onOpenChange={setDuplicating} />
      <DeleteDialog profile={profile} open={deleting} onOpenChange={setDeleting} />
    </AppPage>
  );
}

function HistorySection({ history }: { history: readonly AgentProfileHistoryEntry[] }) {
  const t = useTranslations('agentProfiles.detail');
  const wording = useWorkItemWording();
  return (
    <Section title={t('sections.history')}>
      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('historyEmpty')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm" data-testid="agent-profile-history">
          {history.map((entry, index) => (
            <li key={`${entry.createdAt}-${String(index)}`} className="flex flex-col">
              <span>
                {t('historyEntry', {
                  who: entry.actor?.name ?? t('unknownActor'),
                  action: entry.action,
                })}
                {entry.revision === null ? null : (
                  <span className="text-muted-foreground">
                    {' · '}
                    {t('revision', { revision: entry.revision })}
                  </span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {wording.moment(entry.createdAt)}
                {entry.fields.length === 0
                  ? null
                  : ` · ${t('historyFields', { fields: entry.fields.join(', ') })}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function DuplicateDialog({
  profile,
  open,
  onOpenChange,
}: {
  profile: AgentProfile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('agentProfiles.detail');
  const router = useRouter();
  const duplicate = useDuplicateAgentProfile(profile.workspaceId);
  const [name, setName] = React.useState('');
  const [openedFor, setOpenedFor] = React.useState(false);
  if (open !== openedFor) {
    setOpenedFor(open);
    if (open) setName(t('duplicateNameDefault', { name: profile.name }));
  }

  const confirm = async (): Promise<void> => {
    const created = await duplicate.mutateAsync({ profileId: profile.id, name: name.trim() });
    onOpenChange(false);
    router.push(`/arbeitsbereich/${profile.workspaceId}/agentenprofile/${created.profile.id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('duplicateTitle')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-profile-duplicate-name">{t('duplicateNameLabel')}</Label>
            <Input
              id="agent-profile-duplicate-name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
            {duplicate.error === null ? null : (
              <p className="text-xs text-destructive">{duplicate.error.message}</p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={duplicate.isPending || name.trim().length === 0}
          >
            {t('duplicateConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  profile,
  open,
  onOpenChange,
}: {
  profile: AgentProfile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('agentProfiles.detail');
  const router = useRouter();
  const remove = useDeleteAgentProfile(profile.workspaceId);

  const confirm = async (): Promise<void> => {
    await remove.mutateAsync(profile.id);
    onOpenChange(false);
    router.push(`/arbeitsbereich/${profile.workspaceId}/agentenprofile`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('deleteTitle')}</DialogTitle>
          <DialogDescription>
            {t('deleteDescription', { count: profile.workItemCount })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void confirm()}
            disabled={remove.isPending}
            data-testid="agent-profile-delete-confirm"
          >
            {t('deleteConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
