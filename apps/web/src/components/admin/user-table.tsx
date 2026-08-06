'use client';

import { type UserRole } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Badge,
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

import { useAdminUsers, useUpdateUserRole } from '@/lib/api/admin-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useSessionQuery } from '@/lib/api/queries';

const ROLE_LABELS: Record<UserRole, string> = { user: 'Nutzer', admin: 'Administrator' };

const dateTimeFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });

export function UserTable() {
  const usersQuery = useAdminUsers();
  const sessionQuery = useSessionQuery();
  const updateRole = useUpdateUserRole();

  if (usersQuery.isPending) {
    return <LoadingState label="Nutzer werden geladen …" variant="skeleton" rows={5} />;
  }

  if (usersQuery.isError) {
    return (
      <ErrorState title="Nutzerliste konnte nicht geladen werden" onRetry={() => void usersQuery.refetch()} />
    );
  }

  const currentUserId = sessionQuery.data?.user?.id ?? null;
  const errorCode = updateRole.error instanceof ApiError ? updateRole.error.code : undefined;

  return (
    <div className="flex flex-col gap-4">
      {updateRole.isError ? (
        <Alert variant="destructive" data-testid="user-role-error">
          <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
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
          </TableRow>
        </TableHeader>
        <TableBody>
          {usersQuery.data.map((user) => {
            const isSelf = user.id === currentUserId;
            return (
              <TableRow key={user.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{user.name}</span>
                    {isSelf ? <Badge variant="secondary">Du</Badge> : null}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{user.email}</TableCell>
                <TableCell>
                  <Select
                    value={user.role}
                    disabled={isSelf || updateRole.isPending}
                    onValueChange={(next) =>
                      updateRole.mutate({ userId: user.id, request: { role: next as UserRole } })
                    }
                  >
                    <SelectTrigger aria-label={`Rolle von ${user.name}`} size="sm">
                      <SelectValue />
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
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
