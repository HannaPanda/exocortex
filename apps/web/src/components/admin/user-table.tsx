'use client';

import * as React from 'react';

import { type AdminUser, type UserRole } from '@exocortex/contracts';
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
  ErrorState,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { InvitationTable } from '@/components/invitations/invitation-table';
import { InviteDialog } from '@/components/invitations/invite-dialog';
import {
  useAdminUsers,
  useDeleteUser,
  useUpdateUserRole,
  useUpdateUserStatus,
} from '@/lib/api/admin-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useSessionQuery } from '@/lib/api/session-queries';
import { useWorkspaces } from '@/lib/api/workspace-queries';

const ROLE_LABELS: Record<UserRole, string> = { user: 'Nutzer', admin: 'Administrator' };

const dateTimeFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });

/**
 * The user administration screen: who is here, who is invited, and the two ways
 * somebody stops being here (issue #3).
 *
 * Invitations sit on the same page as the accounts rather than on their own,
 * because they are the same question asked at two points in time. An invitation
 * that was accepted turns into a row in the upper table, and being able to see
 * that happen without navigating is the point.
 */
export function UserTable() {
  const usersQuery = useAdminUsers();
  const sessionQuery = useSessionQuery();
  const workspacesQuery = useWorkspaces();
  const updateRole = useUpdateUserRole();
  const updateStatus = useUpdateUserStatus();
  const deleteUser = useDeleteUser();

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [pendingDeletion, setPendingDeletion] = React.useState<AdminUser | null>(null);

  if (usersQuery.isPending) {
    return <LoadingState label="Nutzer werden geladen …" variant="skeleton" rows={5} />;
  }

  if (usersQuery.isError) {
    return (
      <ErrorState
        title="Nutzerliste konnte nicht geladen werden"
        onRetry={() => void usersQuery.refetch()}
      />
    );
  }

  const currentUserId = sessionQuery.data?.user?.id ?? null;
  const actionError = [updateRole.error, updateStatus.error, deleteUser.error].find(
    (error): error is ApiError => error instanceof ApiError,
  );
  const busy = updateRole.isPending || updateStatus.isPending || deleteUser.isPending;

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold">Nutzer</h2>
          <Button onClick={() => setInviteOpen(true)} data-testid="open-invite-dialog">
            Einladen
          </Button>
        </div>

        {actionError !== undefined ? (
          <Alert variant="destructive" data-testid="user-role-error">
            <AlertDescription>{messageForCode(actionError.code)}</AlertDescription>
          </Alert>
        ) : null}

        <Table>
          <TableCaption className="sr-only">Liste der Nutzer dieser Installation</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>E-Mail</TableHead>
              <TableHead>Rolle</TableHead>
              <TableHead>Arbeitsbereiche</TableHead>
              <TableHead>Zuletzt aktiv</TableHead>
              <TableHead>Registriert</TableHead>
              <TableHead className="sr-only">Aktionen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usersQuery.data.map((user) => {
              const isSelf = user.id === currentUserId;
              const disabled = user.disabledAt !== null;
              return (
                <TableRow key={user.id} className={disabled ? 'opacity-60' : undefined}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{user.name}</span>
                      {isSelf ? <Badge variant="secondary">Du</Badge> : null}
                      {disabled ? (
                        <Badge variant="outline" data-testid={`user-disabled-${user.id}`}>
                          Deaktiviert
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{user.email}</TableCell>
                  <TableCell>
                    <Select
                      value={user.role}
                      disabled={isSelf || busy}
                      onValueChange={(next) =>
                        updateRole.mutate({ userId: user.id, request: { role: next as UserRole } })
                      }
                    >
                      <SelectTrigger aria-label={`Rolle von ${user.name}`} size="sm">
                        {/* Base UI shows the raw value ("admin") without this. */}
                        <SelectValue>{() => ROLE_LABELS[user.role]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">{ROLE_LABELS.user}</SelectItem>
                        <SelectItem value="admin">{ROLE_LABELS.admin}</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>{user.workspaceCount}</TableCell>
                  <TableCell>
                    {user.lastSessionAt !== null
                      ? dateTimeFormat.format(new Date(user.lastSessionAt))
                      : '–'}
                  </TableCell>
                  <TableCell>{dateFormat.format(new Date(user.createdAt))}</TableCell>
                  <TableCell>
                    {isSelf ? (
                      <span className="text-xs text-muted-foreground">–</span>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            updateStatus.mutate({ userId: user.id, disabled: !disabled })
                          }
                          data-testid={`toggle-user-status-${user.id}`}
                        >
                          {disabled ? 'Aktivieren' : 'Deaktivieren'}
                        </Button>
                        {/*
                          Deleting is only offered for an account that authored
                          nothing. Everything else would be a button that always
                          fails, and the honest version of that button is no
                          button plus the reason.
                        */}
                        {user.hasAuthoredContent ? (
                          <span
                            className="self-center text-xs text-muted-foreground"
                            title="Dieses Konto hat Inhalte angelegt und kann nur deaktiviert werden."
                          >
                            hat Inhalte
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setPendingDeletion(user)}
                            data-testid={`delete-user-${user.id}`}
                          >
                            Löschen
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-4 border-t border-border pt-8">
        <h2 className="text-base font-semibold">Einladungen</h2>
        <InvitationTable scope={{ kind: 'admin' }} showWorkspace />
      </section>

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        scope={{ kind: 'admin' }}
        workspaces={workspacesQuery.data ?? []}
        canGrantAdmin
      />

      <Dialog
        open={pendingDeletion !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDeletion(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Konto löschen</DialogTitle>
            <DialogDescription>
              {pendingDeletion?.email} wird endgültig entfernt. Das lässt sich nicht zurücknehmen.
              Wenn du nur den Zugang sperren willst, deaktiviere das Konto stattdessen.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDeletion(null)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (pendingDeletion === null) return;
                deleteUser.mutate(pendingDeletion.id, {
                  onSuccess: () => setPendingDeletion(null),
                });
              }}
              data-testid="confirm-delete-user"
            >
              Löschen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
