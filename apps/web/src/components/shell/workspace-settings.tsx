'use client';

import {
  BotIcon,
  FlaskConicalIcon,
  LayoutTemplateIcon,
  type LucideIcon,
  Share2Icon,
  WaypointsIcon,
  WorkflowIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type WorkspaceDetail, type WorkspaceRole } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
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
  SectionRule,
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
} from '@exocortex/ui';

import { AiRulesPanel } from '@/components/ai/ai-rules-panel';
import { InvitationTable } from '@/components/invitations/invitation-table';
import { InviteDialog } from '@/components/invitations/invite-dialog';
import { ExternalMcpPanel } from '@/components/settings/external-mcp-panel';
import { WorkspaceCredentialsForm } from '@/components/settings/workspace-credentials-form';
import { WorkspaceSettingsForm } from '@/components/settings/workspace-settings-form';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useRemoveWorkspaceMember, useUpdateWorkspaceMember } from '@/lib/api/invitation-queries';
import { useSessionQuery } from '@/lib/api/session-queries';
import { useUpdateWorkspace } from '@/lib/api/workspace-queries';

const WORKSPACE_ADMIN_ROLES: ReadonlySet<string> = new Set(['OWNER', 'ADMIN']);

/**
 * A workspace's settings, as the groups of the settings dialog's
 * "Arbeitsbereich" area (issue #279).
 *
 * They were five tabs of one page before, and before that one page several
 * screens tall: renaming the workspace, deciding who is in it, handing it its
 * own AI key, letting in foreign tools and overriding forty settings are five
 * errands. Each is a group of the dialog now, addressed as
 * `?einstellungen=<group>`, and each is shown only to a role that may use it,
 * as the tabs were (`SETTINGS_SECTIONS` holds who that is).
 */

/**
 * "Allgemein": the name, the slug, whether agents keep their memory here,
 * and the areas that are pages of their own.
 */
export function WorkspaceGeneralSettings({ workspace }: { workspace: WorkspaceDetail }) {
  const canEdit = WORKSPACE_ADMIN_ROLES.has(workspace.role);
  const t = useTranslations('settings.workspace');
  return (
    <div className="flex flex-col gap-8">
      {canEdit ? (
        <>
          <NameSection workspace={workspace} />
          <SlugSection workspace={workspace} />
          <MemorySection workspace={workspace} />
        </>
      ) : (
        <Alert data-testid="workspace-settings-readonly">
          <AlertDescription>{t('readOnly')}</AlertDescription>
        </Alert>
      )}
      <MoreSection workspaceId={workspace.id} />
    </div>
  );
}

/**
 * "KI": the key and the rule pages belong together, because both answer
 * "under what terms does the assistant run here". A key is not a preference
 * though (ADR-023): it is stored encrypted, in its own table, and it is the
 * owner's to enter because it is the owner who pays.
 */
export function WorkspaceAiSettings({ workspace }: { workspace: WorkspaceDetail }) {
  const t = useTranslations('settings.workspace');
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-labelledby="workspace-ai-key-heading">
        <SectionRule as="h3" id="workspace-ai-key-heading">
          {t('aiKey.title')}
        </SectionRule>
        <p className="max-w-measure text-sm text-muted-foreground">{t('aiKey.description')}</p>
        <WorkspaceCredentialsForm workspaceId={workspace.id} isOwner={workspace.role === 'OWNER'} />
      </section>
      {/* A list rather than a link: a rule is a page that already has its own
          screen, and what is missing is the overview of which pages are
          steering the assistant right now (D5). */}
      <section className="flex flex-col gap-3" aria-labelledby="workspace-ai-rules-heading">
        <SectionRule as="h3" id="workspace-ai-rules-heading">
          {t('aiRules.title')}
        </SectionRule>
        <p className="max-w-measure text-sm text-muted-foreground">{t('aiRules.description')}</p>
        <AiRulesPanel workspaceId={workspace.id} />
      </section>
    </div>
  );
}

/**
 * "Externe Werkzeuge", owner only like the API (ADR-086): which foreign
 * server the assistant may call, and with which of its tools, widens what it
 * can do and where this workspace's data can go.
 */
export function WorkspaceToolsSettings({ workspace }: { workspace: WorkspaceDetail }) {
  return <ExternalMcpPanel workspaceId={workspace.id} />;
}

/**
 * "Konfiguration", shown to every member on purpose: what prompt and what
 * model this workspace runs under is not a secret from the people working in
 * it, and a configuration nobody can see is one nobody can explain. Editing
 * stays behind the same bar as the rest.
 */
export function WorkspaceOverridesSettings({ workspace }: { workspace: WorkspaceDetail }) {
  return (
    <WorkspaceSettingsForm
      workspaceId={workspace.id}
      canEdit={WORKSPACE_ADMIN_ROLES.has(workspace.role)}
    />
  );
}

function NameSection({ workspace }: { workspace: WorkspaceDetail }) {
  const updateWorkspace = useUpdateWorkspace();
  const t = useTranslations('settings.workspace');
  const [name, setName] = React.useState(workspace.name);
  const [saved, setSaved] = React.useState(false);
  const dirty = name.trim().length > 0 && name.trim() !== workspace.name;
  const errorCode =
    updateWorkspace.error instanceof ApiError ? updateWorkspace.error.code : undefined;

  const save = (): void => {
    if (!dirty) return;
    updateWorkspace.mutate(
      { workspaceId: workspace.id, request: { name: name.trim() } },
      { onSuccess: () => setSaved(true) },
    );
  };

  return (
    <section className="flex flex-col gap-2">
      {updateWorkspace.isError ? (
        <Alert variant="destructive" data-testid="workspace-settings-error">
          <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
        </Alert>
      ) : null}
      <Label htmlFor="workspace-name">{t('nameLabel')}</Label>
      <form
        className="flex max-w-md gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Input
          id="workspace-name"
          data-testid="workspace-name-input"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
        />
        <Button
          type="submit"
          disabled={!dirty || updateWorkspace.isPending}
          data-testid="save-workspace-name"
        >
          {t('save')}
        </Button>
      </form>
      {saved ? (
        <p className="text-xs text-success" data-testid="workspace-name-saved">
          {t('nameSaved')}
        </p>
      ) : null}
    </section>
  );
}

/** A page of its own that belongs to the workspace's settings by subject. */
interface WorkspacePage {
  key: 'automations' | 'workflows' | 'agentProfiles' | 'evals' | 'templates' | 'shares';
  path: string;
  icon: LucideIcon;
  testId?: string;
}

const WORKSPACE_PAGES: readonly WorkspacePage[] = [
  { key: 'automations', path: 'automationen', icon: WorkflowIcon },
  { key: 'workflows', path: 'workflows', icon: WaypointsIcon },
  { key: 'agentProfiles', path: 'agentenprofile', icon: BotIcon },
  { key: 'evals', path: 'evals', icon: FlaskConicalIcon },
  { key: 'templates', path: 'vorlagen', icon: LayoutTemplateIcon },
  { key: 'shares', path: 'freigaben', icon: Share2Icon, testId: 'open-workspace-shares' },
];

/**
 * The areas that are pages rather than groups of the dialog.
 *
 * Each has a list, a log or an editor of its own: automations their run log
 * (issue #50), workflows a canvas (issue #198), a PDF template a LaTeX
 * preamble (issue #44), the shares a table of every grant. None of that fits
 * in a dialog over somebody's work, so they stay pages, and this is where the
 * settings point at them, so nothing has to be remembered.
 */
function MoreSection({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('settings.workspace.more');
  return (
    <section className="flex flex-col gap-3" aria-labelledby="workspace-more-heading">
      <SectionRule as="h3" id="workspace-more-heading">
        {t('title')}
      </SectionRule>
      <p className="max-w-measure text-sm text-muted-foreground">{t('description')}</p>
      <ul className="flex flex-col gap-0.5">
        {WORKSPACE_PAGES.map((page) => (
          <li key={page.key}>
            <Link
              href={`/arbeitsbereich/${workspaceId}/${page.path}`}
              data-testid={page.testId}
              className="flex min-h-9 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-accent max-md:min-h-11"
            >
              <page.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{t(page.key)}</span>
            </Link>
          </li>
        ))}
      </ul>
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
    <section className="flex flex-col gap-2">
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

/**
 * Who is in this workspace, and how somebody else gets in (issue #3).
 *
 * The member list existed only as an API route until now, which is what left
 * "invite from the member list" with no list to sit on. Roles are editable here
 * for the same reason the invite button lives here: both answer "who may do what
 * in this workspace", and splitting that across two screens means the owner has
 * to guess which one they wanted.
 */
export function WorkspaceMembersSettings({ workspace }: { workspace: WorkspaceDetail }) {
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
    <div className="flex flex-col gap-4">
      {/* The group's name and intro stand above it in the dialog; what is
          left of the old header is the one action the list is for. */}
      <div className="flex justify-end">
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
        <SectionRule as="h3">{t('openInvitations')}</SectionRule>
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
    </div>
  );
}
