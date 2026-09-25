'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type WorkspaceDetail, type WorkspaceRole } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  AppPage,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@exocortex/ui';

import { AiRulesPanel } from '@/components/ai/ai-rules-panel';
import { InvitationTable } from '@/components/invitations/invitation-table';
import { InviteDialog } from '@/components/invitations/invite-dialog';
import { isWorkspaceSettingsTab } from '@/components/palette/settings-addresses';
import { WorkspaceCredentialsForm } from '@/components/settings/workspace-credentials-form';
import { WorkspaceSettingsForm } from '@/components/settings/workspace-settings-form';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useRemoveWorkspaceMember, useUpdateWorkspaceMember } from '@/lib/api/invitation-queries';
import { useSessionQuery } from '@/lib/api/session-queries';
import { useUpdateWorkspace, useWorkspaceDetail } from '@/lib/api/workspace-queries';
import { useRequestedState } from '@/lib/use-requested-state';

const WORKSPACE_ADMIN_ROLES = new Set(['OWNER', 'ADMIN']);

/**
 * Workspace settings, split into tabs.
 *
 * Everything on this screen answers "how does this workspace work", but not at
 * the same moment: renaming it, deciding who is in it, handing it its own API
 * key and overriding forty settings are four errands, and stacking them made
 * one page several screens tall in which the thing you came for was always
 * below the fold. The tabs are those four errands; nothing was removed.
 */
export function WorkspaceSettings({
  workspaceId,
  requestedTab = null,
}: {
  workspaceId: string;
  /** From `?tab=`; anything that is not a tab opens the first one. */
  requestedTab?: string | null;
}) {
  const detail = useWorkspaceDetail(workspaceId);
  const updateWorkspace = useUpdateWorkspace();
  const t = useTranslations('settings.workspace');

  const [name, setName] = React.useState<string | null>(null);
  const [nameSaved, setNameSaved] = React.useState(false);
  const [tab, setTab] = useRequestedState<string>(
    requestedTab !== null && isWorkspaceSettingsTab(requestedTab) ? requestedTab : null,
    'general',
  );

  // Initialise the draft once the query resolves (see SettingsForm for why
  // this runs during render rather than in an effect).
  if (name === null && detail.data !== undefined) setName(detail.data.name);

  if (detail.isPending || detail.data === undefined || name === null) {
    return <LoadingState label={t('loading')} />;
  }

  const original = detail.data;
  const canEdit = WORKSPACE_ADMIN_ROLES.has(original.role);
  const nameDirty = name.trim().length > 0 && name.trim() !== original.name;

  const errorCode =
    updateWorkspace.error instanceof ApiError ? updateWorkspace.error.code : undefined;

  const saveName = (): void => {
    if (!nameDirty) return;
    updateWorkspace.mutate(
      { workspaceId, request: { name: name.trim() } },
      { onSuccess: () => setNameSaved(true) },
    );
  };

  return (
    <AppPage maxWidth="max-w-4xl">
      <h1 className="exocortex-page-title">{t('title')}</h1>
      <p className="mt-1 max-w-measure text-sm text-muted-foreground">
        {t('summary', { name: original.name, count: original.memberCount })}
      </p>

      <Tabs
        value={tab}
        onValueChange={(next) => setTab(typeof next === 'string' ? next : 'general')}
        className="mt-6 flex flex-col gap-8"
      >
        {/* `min-h-10`, not `h-10`: a fixed height would keep the row from
            wrapping on a phone, which is the whole point of the wrap. */}
        <TabsList className="min-h-10 gap-1 p-1" data-testid="workspace-settings-tabs">
          <TabsTrigger value="general" className="py-1.5 text-sm">
            {t('tabs.general')}
          </TabsTrigger>
          {canEdit ? (
            <TabsTrigger value="members" className="py-1.5 text-sm">
              {t('tabs.members')}
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="ai" className="py-1.5 text-sm">
            {t('tabs.ai')}
          </TabsTrigger>
          <TabsTrigger value="overrides" className="py-1.5 text-sm">
            {t('tabs.settings')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="flex flex-col gap-8">
          {!canEdit ? (
            <Alert data-testid="workspace-settings-readonly">
              <AlertDescription>{t('readOnly')}</AlertDescription>
            </Alert>
          ) : (
            <>
              {updateWorkspace.isError ? (
                <Alert variant="destructive" data-testid="workspace-settings-error">
                  <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
                </Alert>
              ) : null}

              <section className="flex flex-col gap-2">
                <Label htmlFor="workspace-name">{t('nameLabel')}</Label>
                <div className="flex max-w-md gap-2">
                  <Input
                    id="workspace-name"
                    data-testid="workspace-name-input"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setNameSaved(false);
                    }}
                  />
                  <Button
                    onClick={saveName}
                    disabled={!nameDirty || updateWorkspace.isPending}
                    data-testid="save-workspace-name"
                  >
                    {t('save')}
                  </Button>
                </div>
                {nameSaved ? (
                  <p className="text-xs text-success" data-testid="workspace-name-saved">
                    {t('nameSaved')}
                  </p>
                ) : null}
              </section>

              <SlugSection workspace={original} />

              <MemorySection workspace={original} />
            </>
          )}

          <MoreSection workspaceId={workspaceId} />
        </TabsContent>

        {canEdit ? (
          <TabsContent value="members">
            <MembersSection workspace={original} />
          </TabsContent>
        ) : null}

        {/* The key and the rule pages belong together: both answer "under what
            terms does the assistant run here". A key is not a preference
            though (ADR-023) -- it is stored encrypted, in its own table, and
            it is the owner's to enter because it is the owner who pays. */}
        <TabsContent value="ai" className="flex flex-col gap-10">
          <section className="flex flex-col gap-4">
            <div>
              <h2 className="text-base font-semibold">{t('aiKey.title')}</h2>
              <p className="mt-1 max-w-measure text-sm text-muted-foreground">
                {t('aiKey.description')}
              </p>
            </div>
            <WorkspaceCredentialsForm
              workspaceId={workspaceId}
              isOwner={original.role === 'OWNER'}
            />
          </section>

          {/* A list rather than a link: a rule is a page that already has its
              own screen, and what is missing is the overview of which pages are
              steering the assistant right now (D5). */}
          <section className="flex flex-col gap-4 border-t border-border pt-8">
            <div>
              <h2 className="text-base font-semibold">{t('aiRules.title')}</h2>
              <p className="mt-1 max-w-measure text-sm text-muted-foreground">
                {t('aiRules.description')}
              </p>
            </div>
            <AiRulesPanel workspaceId={workspaceId} />
          </section>
        </TabsContent>

        {/* Outside the administrator branch on purpose: what prompt and what
            model this workspace runs under is not a secret from the people
            working in it, and a configuration nobody can see is one nobody can
            explain. Editing stays behind the same bar as the rest. */}
        <TabsContent value="overrides" className="flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold">{t('config.title')}</h2>
            <p className="mt-1 max-w-measure text-sm text-muted-foreground">
              {t('config.description')}
            </p>
          </div>
          <WorkspaceSettingsForm workspaceId={workspaceId} canEdit={canEdit} />
        </TabsContent>
      </Tabs>
    </AppPage>
  );
}

/**
 * The two areas that are pages of their own rather than panels.
 *
 * Automations have a run log beside them and a log is the half people come
 * back for (issue #50); a PDF template has a LaTeX preamble somebody edits
 * (issue #44). Neither fits in a row of a settings form, so both stay links --
 * but a link nobody finds is no better than no link, which is why they sit in
 * the first tab rather than at the bottom of a long page.
 */
function MoreSection({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('settings.workspace.more');
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-8">
      <h2 className="text-base font-semibold">{t('title')}</h2>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          render={<Link href={`/arbeitsbereich/${workspaceId}/automationen`} />}
          variant="outline"
          className="justify-start"
        >
          {t('automations')}
        </Button>
        <Button
          render={<Link href={`/arbeitsbereich/${workspaceId}/vorlagen`} />}
          variant="outline"
          className="justify-start"
        >
          {t('templates')}
        </Button>
        <Button
          render={<Link href={`/arbeitsbereich/${workspaceId}/freigaben`} />}
          variant="outline"
          className="justify-start"
          data-testid="open-workspace-shares"
        >
          {t('shares')}
        </Button>
      </div>
      <p className="max-w-measure text-xs text-muted-foreground">{t('description')}</p>
    </section>
  );
}

/**
 * The slug, with its own draft, its own save button and a confirmation step.
 *
 * Separate from the name for the reason the warning gives: renaming never
 * touches the slug, and the slug is the one thing already-shared links depend
 * on, so changing it takes a deliberate second click.
 */
function SlugSection({ workspace }: { workspace: WorkspaceDetail }) {
  const router = useRouter();
  const updateWorkspace = useUpdateWorkspace();
  const t = useTranslations('settings.workspace');
  const [slug, setSlug] = React.useState(workspace.slug);
  const [confirming, setConfirming] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  const dirty = slug.trim().length > 0 && slug.trim() !== workspace.slug;

  const save = (): void => {
    if (!dirty) return;
    updateWorkspace.mutate(
      { workspaceId: workspace.id, request: { slug: slug.trim() } },
      {
        onSuccess: () => {
          setSaved(true);
          setConfirming(false);
          // The slug can be part of the current URL in a future route; there is
          // none today, but refreshing keeps this page consistent either way.
          router.refresh();
        },
      },
    );
  };

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-6">
      <Label htmlFor="workspace-slug">{t('slug.label')}</Label>
      <p className="max-w-measure text-xs text-muted-foreground">{t('slug.description')}</p>
      <div className="flex max-w-md gap-2">
        <Input
          id="workspace-slug"
          data-testid="workspace-slug-input"
          value={slug}
          onChange={(event) => {
            setSlug(event.target.value);
            setSaved(false);
            setConfirming(false);
          }}
        />
        {dirty && !confirming ? (
          <Button
            variant="outline"
            onClick={() => setConfirming(true)}
            data-testid="confirm-workspace-slug-change"
          >
            {t('slug.confirm')}
          </Button>
        ) : (
          <Button
            onClick={save}
            disabled={!dirty || !confirming || updateWorkspace.isPending}
            data-testid="save-workspace-slug"
          >
            {t('save')}
          </Button>
        )}
      </div>
      {saved ? (
        <p className="text-xs text-success" data-testid="workspace-slug-saved">
          {t('slug.saved')}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Who is in this workspace, and how somebody else gets in (issue #3).
 *
 * The member list existed only as an API route until now, which is what left
 * "invite from the member list" with no list to sit on. Roles are editable here
 * for the same reason the invite button lives here: both answer "who may do what
 * in this workspace", and splitting that across two screens means the owner has
 * to guess which one they wanted.
 */
/**
 * Marks this workspace as the agent memory area (issue #52, ADR-023).
 *
 * A switch rather than a setting, because the memory is a property of the
 * workspace now: `recall` and `remember` are handed a user and a project, so
 * the only place the question can be answered is the row itself.
 *
 * The warning is not decoration. Switching this on means agents start writing
 * session notes here by themselves, and that notes age out on the retention
 * this workspace has configured -- which is exactly what a curated area must
 * never have done to it.
 */
function MemorySection({ workspace }: { workspace: WorkspaceDetail }) {
  const updateWorkspace = useUpdateWorkspace();
  const t = useTranslations('settings.workspace');
  const [saved, setSaved] = React.useState(false);

  return (
    <section className="flex flex-col gap-2">
      <Label htmlFor="workspace-is-memory">{t('memory.label')}</Label>
      <div className="flex items-start gap-3">
        <Switch
          id="workspace-is-memory"
          data-testid="workspace-is-memory"
          checked={workspace.isMemory}
          disabled={updateWorkspace.isPending}
          onCheckedChange={(next) => {
            setSaved(false);
            updateWorkspace.mutate(
              { workspaceId: workspace.id, request: { isMemory: next } },
              { onSuccess: () => setSaved(true) },
            );
          }}
        />
        <p className="max-w-measure text-xs text-muted-foreground">{t('memory.description')}</p>
      </div>
      {saved ? (
        <p className="text-xs text-success" data-testid="workspace-is-memory-saved">
          {t('saved')}
        </p>
      ) : null}
    </section>
  );
}

function MembersSection({ workspace }: { workspace: WorkspaceDetail }) {
  const sessionQuery = useSessionQuery();
  const updateMember = useUpdateWorkspaceMember(workspace.id);
  const removeMember = useRemoveWorkspaceMember(workspace.id);
  const t = useTranslations('settings.workspace.members');
  const tRole = useTranslations('settings.workspace.roles');
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [pendingRemoval, setPendingRemoval] = React.useState<
    WorkspaceDetail['members'][number] | null
  >(null);

  const currentUserId = sessionQuery.data?.user?.id ?? null;
  const isOwner = workspace.role === 'OWNER';
  const failed = updateMember.error ?? removeMember.error;
  const errorCode = failed instanceof ApiError ? failed.code : undefined;

  /**
   * Only an owner may hand out or take back ownership (`canChangeMemberRole`), so
   * everybody else is offered the three roles they can actually set. The API
   * refuses either way; this just avoids an option that always fails.
   */
  const assignableRoles: readonly WorkspaceRole[] = isOwner
    ? ['OWNER', 'ADMIN', 'MEMBER', 'GUEST']
    : ['ADMIN', 'MEMBER', 'GUEST'];

  return (
    <section className="flex flex-col gap-4 border-t border-border pt-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">{t('title')}</h2>
          <p className="max-w-measure text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <Button onClick={() => setInviteOpen(true)} data-testid="open-workspace-invite">
          {t('invite')}
        </Button>
      </div>

      {updateMember.isError || removeMember.isError ? (
        <Alert variant="destructive" data-testid="member-role-error">
          <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
        </Alert>
      ) : null}

      <Table narrow="list">
        <TableCaption className="sr-only">{t('caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>{t('name')}</TableHead>
            <TableHead>{t('email')}</TableHead>
            <TableHead>{t('role')}</TableHead>
            <TableHead className="sr-only">{t('actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workspace.members.map((member) => (
            <TableRow key={member.id}>
              <TableCell cell="title">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{member.name}</span>
                  {member.userId === currentUserId ? (
                    <Badge variant="secondary">{t('you')}</Badge>
                  ) : null}
                </div>
              </TableCell>
              <TableCell label={t('email')} className="text-muted-foreground">
                {member.email}
              </TableCell>
              <TableCell label={t('role')}>
                <Select
                  value={member.role}
                  disabled={updateMember.isPending || (member.role === 'OWNER' && !isOwner)}
                  onValueChange={(next) =>
                    updateMember.mutate({ userId: member.userId, role: next as WorkspaceRole })
                  }
                >
                  <SelectTrigger aria-label={t('roleOf', { name: member.name })} size="sm">
                    <SelectValue>{() => tRole(member.role)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {assignableRoles.map((role) => (
                      <SelectItem key={role} value={role}>
                        {tRole(role)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell cell="actions" className="text-right">
                {/*
                  Removing yourself is refused by the server and left out here:
                  leaving a workspace is a different act from being removed from
                  one, and an owner who does it by accident has nobody left to
                  let them back in.
                */}
                {member.userId === currentUserId ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={removeMember.isPending || (member.role === 'OWNER' && !isOwner)}
                    onClick={() => setPendingRemoval(member)}
                    data-testid={`remove-member-${member.userId}`}
                  >
                    {t('remove')}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="flex flex-col gap-2 pt-2">
        <h3 className="text-sm font-medium">{t('openInvitations')}</h3>
        <InvitationTable scope={{ kind: 'workspace', workspaceId: workspace.id }} />
      </div>

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        scope={{ kind: 'workspace', workspaceId: workspace.id }}
      />

      <Dialog
        open={pendingRemoval !== null}
        onOpenChange={(next) => {
          if (!next) setPendingRemoval(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('removeTitle')}</DialogTitle>
            <DialogDescription>
              {t('removeDescription', { name: pendingRemoval?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRemoval(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={removeMember.isPending}
              onClick={() => {
                if (pendingRemoval === null) return;
                removeMember.mutate(pendingRemoval.userId, {
                  onSuccess: () => setPendingRemoval(null),
                });
              }}
              data-testid="confirm-remove-member"
            >
              {t('remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
