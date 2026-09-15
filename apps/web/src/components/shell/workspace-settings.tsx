'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { type WorkspaceDetail, type WorkspaceRole } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  AppPage,
  Badge,
  Button,
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
import { WorkspaceCredentialsForm } from '@/components/settings/workspace-credentials-form';
import { WorkspaceSettingsForm } from '@/components/settings/workspace-settings-form';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useUpdateWorkspaceMember } from '@/lib/api/invitation-queries';
import { useSessionQuery, useUpdateWorkspace, useWorkspaceDetail } from '@/lib/api/queries';

const WORKSPACE_ADMIN_ROLES = new Set(['OWNER', 'ADMIN']);

const MEMBER_ROLE_LABELS: Record<WorkspaceRole, string> = {
  OWNER: 'Besitzer',
  ADMIN: 'Administrator',
  MEMBER: 'Mitglied',
  GUEST: 'Gast',
};

/**
 * Workspace settings, split into tabs.
 *
 * Everything on this screen answers "how does this workspace work", but not at
 * the same moment: renaming it, deciding who is in it, handing it its own API
 * key and overriding forty settings are four errands, and stacking them made
 * one page several screens tall in which the thing you came for was always
 * below the fold. The tabs are those four errands; nothing was removed.
 */
export function WorkspaceSettings({ workspaceId }: { workspaceId: string }) {
  const detail = useWorkspaceDetail(workspaceId);
  const updateWorkspace = useUpdateWorkspace();

  const [name, setName] = React.useState<string | null>(null);
  const [nameSaved, setNameSaved] = React.useState(false);
  const [tab, setTab] = React.useState('allgemein');

  // Initialise the draft once the query resolves (see SettingsForm for why
  // this runs during render rather than in an effect).
  if (name === null && detail.data !== undefined) setName(detail.data.name);

  if (detail.isPending || detail.data === undefined || name === null) {
    return <LoadingState label="Arbeitsbereich wird geladen …" />;
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
      <h1 className="text-lg font-semibold">Arbeitsbereich-Einstellungen</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {original.name} · {original.memberCount}{' '}
        {original.memberCount === 1 ? 'Mitglied' : 'Mitglieder'}
      </p>

      <Tabs
        value={tab}
        onValueChange={(next) => setTab(typeof next === 'string' ? next : 'allgemein')}
        className="mt-6 flex flex-col gap-8"
      >
        <TabsList className="h-10 gap-1 p-1" data-testid="workspace-settings-tabs">
          <TabsTrigger value="allgemein" className="py-1.5 text-sm">
            Allgemein
          </TabsTrigger>
          {canEdit ? (
            <TabsTrigger value="mitglieder" className="py-1.5 text-sm">
              Mitglieder
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="ki" className="py-1.5 text-sm">
            KI
          </TabsTrigger>
          <TabsTrigger value="einstellungen" className="py-1.5 text-sm">
            Einstellungen
          </TabsTrigger>
        </TabsList>

        <TabsContent value="allgemein" className="flex flex-col gap-8">
          {!canEdit ? (
            <Alert data-testid="workspace-settings-readonly">
              <AlertDescription>
                Nur Besitzer und Administratoren dieses Arbeitsbereichs können ihn umbenennen oder
                den Slug ändern.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              {updateWorkspace.isError ? (
                <Alert variant="destructive" data-testid="workspace-settings-error">
                  <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
                </Alert>
              ) : null}

              <section className="flex flex-col gap-2">
                <Label htmlFor="workspace-name">Name</Label>
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
                    Speichern
                  </Button>
                </div>
                {nameSaved ? (
                  <p className="text-xs text-success" data-testid="workspace-name-saved">
                    Name gespeichert.
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
          <TabsContent value="mitglieder">
            <MembersSection workspace={original} />
          </TabsContent>
        ) : null}

        {/* The key and the rule pages belong together: both answer "under what
            terms does the assistant run here". A key is not a preference
            though (ADR-023) -- it is stored encrypted, in its own table, and
            it is the owner's to enter because it is the owner who pays. */}
        <TabsContent value="ki" className="flex flex-col gap-10">
          <section className="flex flex-col gap-4">
            <div>
              <h2 className="text-base font-semibold">Eigener Schlüssel für die KI</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Ohne eigenen Schlüssel laufen die Anfragen dieses Arbeitsbereichs über den der
                Installation.
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
              <h2 className="text-base font-semibold">KI-Regeln</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Seiten, die die KI als Anweisung behandelt. Gesetzt wird das in den Eigenschaften
                der jeweiligen Seite.
              </p>
            </div>
            <AiRulesPanel workspaceId={workspaceId} />
          </section>
        </TabsContent>

        {/* Outside the administrator branch on purpose: what prompt and what
            model this workspace runs under is not a secret from the people
            working in it, and a configuration nobody can see is one nobody can
            explain. Editing stays behind the same bar as the rest. */}
        <TabsContent value="einstellungen" className="flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold">Konfiguration dieses Arbeitsbereichs</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Diese Werte gelten nur hier. Alles andere kommt aus der Installation.
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
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-8">
      <h2 className="text-base font-semibold">Weitere Bereiche</h2>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          render={<Link href={`/arbeitsbereich/${workspaceId}/automationen`} />}
          variant="outline"
          className="justify-start"
        >
          Automationen öffnen
        </Button>
        <Button
          render={<Link href={`/arbeitsbereich/${workspaceId}/vorlagen`} />}
          variant="outline"
          className="justify-start"
        >
          Vorlagen für PDF öffnen
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Regeln, die auf Änderungen an Seiten reagieren, mit dem Protokoll dessen, was sie getan
        haben. Und womit sich Seiten dieses Arbeitsbereichs als PDF veröffentlichen lassen.
      </p>
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
      <Label htmlFor="workspace-slug">Slug</Label>
      <p className="text-xs text-muted-foreground">
        Der Slug steckt in Links, die bereits verschickt oder gespeichert wurden. Anders als der
        Name wandert er nicht automatisch mit &ndash; und eine Änderung bricht diese Links.
      </p>
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
            Trotzdem ändern
          </Button>
        ) : (
          <Button
            onClick={save}
            disabled={!dirty || !confirming || updateWorkspace.isPending}
            data-testid="save-workspace-slug"
          >
            Speichern
          </Button>
        )}
      </div>
      {saved ? (
        <p className="text-xs text-success" data-testid="workspace-slug-saved">
          Slug gespeichert.
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
  const [saved, setSaved] = React.useState(false);

  return (
    <section className="flex flex-col gap-2">
      <Label htmlFor="workspace-is-memory">Gedächtnis der Agenten</Label>
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
        <p className="text-xs text-muted-foreground">
          Agenten legen ihre Sitzungsnotizen in diesem Arbeitsbereich ab und finden sie beim
          nächsten Start wieder. Notizen verfallen hier nach der eingestellten Frist. Für einen
          Bereich, den du selbst pflegst, ist das nichts.
        </p>
      </div>
      {saved ? (
        <p className="text-xs text-success" data-testid="workspace-is-memory-saved">
          Gespeichert.
        </p>
      ) : null}
    </section>
  );
}

function MembersSection({ workspace }: { workspace: WorkspaceDetail }) {
  const sessionQuery = useSessionQuery();
  const updateMember = useUpdateWorkspaceMember(workspace.id);
  const [inviteOpen, setInviteOpen] = React.useState(false);

  const currentUserId = sessionQuery.data?.user?.id ?? null;
  const isOwner = workspace.role === 'OWNER';
  const errorCode = updateMember.error instanceof ApiError ? updateMember.error.code : undefined;

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
          <h2 className="text-sm font-medium">Mitglieder</h2>
          <p className="text-xs text-muted-foreground">
            Mitgliedschaften gelten immer ausdrücklich: wer eingeladen wird, landet genau in diesem
            Arbeitsbereich.
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)} data-testid="open-workspace-invite">
          Einladen
        </Button>
      </div>

      {updateMember.isError ? (
        <Alert variant="destructive" data-testid="member-role-error">
          <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
        </Alert>
      ) : null}

      <Table>
        <TableCaption className="sr-only">Mitglieder dieses Arbeitsbereichs</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>E-Mail</TableHead>
            <TableHead>Rolle</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workspace.members.map((member) => (
            <TableRow key={member.id}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{member.name}</span>
                  {member.userId === currentUserId ? <Badge variant="secondary">Du</Badge> : null}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">{member.email}</TableCell>
              <TableCell>
                <Select
                  value={member.role}
                  disabled={updateMember.isPending || (member.role === 'OWNER' && !isOwner)}
                  onValueChange={(next) =>
                    updateMember.mutate({ userId: member.userId, role: next as WorkspaceRole })
                  }
                >
                  <SelectTrigger aria-label={`Rolle von ${member.name}`} size="sm">
                    <SelectValue>{() => MEMBER_ROLE_LABELS[member.role]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {assignableRoles.map((role) => (
                      <SelectItem key={role} value={role}>
                        {MEMBER_ROLE_LABELS[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="flex flex-col gap-2 pt-2">
        <h3 className="text-sm font-medium">Offene Einladungen</h3>
        <InvitationTable scope={{ kind: 'workspace', workspaceId: workspace.id }} />
      </div>

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        scope={{ kind: 'workspace', workspaceId: workspace.id }}
      />
    </section>
  );
}
