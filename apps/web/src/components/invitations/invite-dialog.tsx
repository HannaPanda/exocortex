'use client';

import * as React from 'react';

import {
  type CreateInvitationRequest,
  INVITATION_DEFAULT_TTL_DAYS,
  type InvitationWorkspaceRole,
  type Workspace,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { type InvitationScope, useCreateInvitation } from '@/lib/api/invitation-queries';

const WORKSPACE_ROLE_LABELS: Record<InvitationWorkspaceRole, string> = {
  ADMIN: 'Administrator',
  MEMBER: 'Mitglied',
  GUEST: 'Gast (nur lesen)',
};

const WORKSPACE_ROLE_ORDER: readonly InvitationWorkspaceRole[] = ['MEMBER', 'ADMIN', 'GUEST'];

/** Sentinel for "no workspace"; distinct from every real workspace id. */
const NO_WORKSPACE = '__none__';

export interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: InvitationScope;
  /**
   * Workspaces the invitation may lead into. Only the admin dialog offers a
   * choice; from inside a workspace the destination is already decided.
   */
  workspaces?: readonly Workspace[];
  /** Whether the caller may hand out global admin rights. Admin dialog only. */
  canGrantAdmin?: boolean;
}

/**
 * Inviting somebody (issue #3).
 *
 * One dialog for both places it is reachable from, because the decision is the
 * same one in both: an address, a destination, a role. What differs is what the
 * caller is allowed to choose, and that is passed in rather than sniffed out --
 * the API enforces it regardless, so this only decides which fields are worth
 * showing.
 *
 * After a successful invitation the dialog does not close. It shows the link,
 * because the mail can fail and a link nobody copied is an invitation nobody
 * received: `emailSent: false` with a working link is recoverable, and staying
 * open is what makes it recoverable.
 */
export function InviteDialog({
  open,
  onOpenChange,
  scope,
  workspaces,
  canGrantAdmin = false,
}: InviteDialogProps) {
  const createInvitation = useCreateInvitation(scope);

  const [email, setEmail] = React.useState('');
  const [workspaceId, setWorkspaceId] = React.useState<string>(NO_WORKSPACE);
  const [workspaceRole, setWorkspaceRole] = React.useState<InvitationWorkspaceRole>('MEMBER');
  const [grantAdmin, setGrantAdmin] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const result = createInvitation.data ?? null;
  const errorCode =
    createInvitation.error instanceof ApiError ? createInvitation.error.code : undefined;

  const reset = (): void => {
    setEmail('');
    setWorkspaceId(NO_WORKSPACE);
    setWorkspaceRole('MEMBER');
    setGrantAdmin(false);
    setCopied(false);
    createInvitation.reset();
  };

  const close = (): void => {
    onOpenChange(false);
    reset();
  };

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const request: CreateInvitationRequest = {
      email: email.trim(),
      workspaceRole,
      role: grantAdmin ? 'admin' : 'user',
      expiresInDays: INVITATION_DEFAULT_TTL_DAYS,
      ...(scope.kind === 'admin' && workspaceId !== NO_WORKSPACE ? { workspaceId } : {}),
    };
    createInvitation.mutate(request);
  };

  const copyLink = (): void => {
    if (result === null) return;
    void navigator.clipboard.writeText(result.url).then(() => setCopied(true));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Einladen</DialogTitle>
          <DialogDescription>
            {scope.kind === 'admin'
              ? 'Die eingeladene Person legt über den Link selbst ein Konto an. Registrieren ohne Einladung ist nicht möglich.'
              : 'Die eingeladene Person legt über den Link ein Konto an und wird Mitglied dieses Arbeitsbereichs.'}
          </DialogDescription>
        </DialogHeader>

        {result !== null ? (
          <div className="flex flex-col gap-4">
            {result.emailSent ? (
              <Alert data-testid="invite-sent">
                <AlertDescription>
                  Einladung an {result.invitation.email} verschickt. Der Link gilt{' '}
                  {INVITATION_DEFAULT_TTL_DAYS} Tage und lässt sich nur einmal verwenden.
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="destructive" data-testid="invite-mail-failed">
                <AlertDescription>
                  Die Einladung wurde angelegt, aber die E-Mail ließ sich nicht verschicken. Gib den
                  Link unten direkt weiter, oder schick die Einladung später erneut.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-link">Einladungslink</Label>
              <div className="flex gap-2">
                <Input id="invite-link" readOnly value={result.url} data-testid="invite-link" />
                <Button variant="outline" onClick={copyLink} data-testid="copy-invite-link">
                  {copied ? 'Kopiert' : 'Kopieren'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Dieser Link wird nur jetzt angezeigt. Er steht nirgends gespeichert, also kopiere
                ihn jetzt, wenn du ihn brauchst.
              </p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={reset} data-testid="invite-another">
                Weitere einladen
              </Button>
              <Button onClick={close}>Fertig</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={submit}>
            {createInvitation.isError ? (
              <Alert variant="destructive" data-testid="invite-error">
                <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-email">E-Mail-Adresse</Label>
              <Input
                id="invite-email"
                type="email"
                autoComplete="off"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                data-testid="invite-email"
              />
            </div>

            {scope.kind === 'admin' && workspaces !== undefined ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="invite-workspace">Arbeitsbereich</Label>
                <Select
                  value={workspaceId}
                  onValueChange={(next) => setWorkspaceId(next ?? NO_WORKSPACE)}
                >
                  <SelectTrigger id="invite-workspace" aria-label="Arbeitsbereich">
                    <SelectValue>
                      {() =>
                        workspaceId === NO_WORKSPACE
                          ? 'Keiner'
                          : (workspaces.find((item) => item.id === workspaceId)?.name ?? 'Keiner')
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_WORKSPACE}>Keiner</SelectItem>
                    {workspaces.map((workspace) => (
                      <SelectItem key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Ohne Arbeitsbereich entsteht ein Konto, das noch nichts sieht. Mitgliedschaften
                  werden hier immer ausdrücklich vergeben.
                </p>
              </div>
            ) : null}

            {scope.kind === 'workspace' || workspaceId !== NO_WORKSPACE ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="invite-role">Rolle im Arbeitsbereich</Label>
                <Select
                  value={workspaceRole}
                  onValueChange={(next) => setWorkspaceRole(next as InvitationWorkspaceRole)}
                >
                  <SelectTrigger id="invite-role" aria-label="Rolle im Arbeitsbereich">
                    <SelectValue>{() => WORKSPACE_ROLE_LABELS[workspaceRole]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {WORKSPACE_ROLE_ORDER.map((role) => (
                      <SelectItem key={role} value={role}>
                        {WORKSPACE_ROLE_LABELS[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {canGrantAdmin ? (
              <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="invite-admin">Administrator dieser Installation</Label>
                  <p className="text-xs text-muted-foreground">
                    Darf Nutzer verwalten, Einstellungen ändern und alle Arbeitsbereiche sehen.
                  </p>
                </div>
                <Switch
                  id="invite-admin"
                  checked={grantAdmin}
                  onCheckedChange={setGrantAdmin}
                  data-testid="invite-grant-admin"
                />
              </div>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Abbrechen
              </Button>
              <Button
                type="submit"
                disabled={email.trim().length === 0 || createInvitation.isPending}
                data-testid="invite-submit"
              >
                {createInvitation.isPending ? 'Wird verschickt …' : 'Einladen'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
