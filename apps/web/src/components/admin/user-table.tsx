'use client';

import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import { type AdminUser, type AdminUserSort, type UserRole } from '@exocortex/contracts';
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
  EmptyState,
  ErrorState,
  LoadingState,
  SectionRule,
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

import { ListPager, pageFrom, SortableHead, useListParams } from '@/components/admin/list-controls';
import {
  isUserListFiltered,
  USER_LIST_DEFAULTS,
  USER_PAGE_SIZE,
  UserListFilters,
  userListQuery,
} from '@/components/admin/user-list-filters';
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
  const [params, setParams] = useListParams(USER_LIST_DEFAULTS);
  const usersQuery = useAdminUsers(userListQuery(params));
  const filtered = isUserListFiltered(params);
  const onSort = (sort: AdminUserSort, order: 'asc' | 'desc') => setParams({ sort, order });
  const sessionQuery = useSessionQuery();
  const workspacesQuery = useWorkspaces();
  const updateRole = useUpdateUserRole();
  const updateStatus = useUpdateUserStatus();
  const deleteUser = useDeleteUser();
  const t = useTranslations('admin.users');
  const format = useFormatter();
  const roleLabel = (role: UserRole): string => t(`roles.${role}`);

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [pendingDeletion, setPendingDeletion] = React.useState<AdminUser | null>(null);

  const currentUserId = sessionQuery.data?.user?.id ?? null;
  const actionError = [updateRole.error, updateStatus.error, deleteUser.error].find(
    (error): error is ApiError => error instanceof ApiError,
  );
  // While the next page or filter loads, the rows on screen belong to the
  // previous answer; acting on them then would be acting on a list the person
  // has already left.
  const busy =
    updateRole.isPending ||
    updateStatus.isPending ||
    deleteUser.isPending ||
    usersQuery.isPlaceholderData;

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <SectionRule
          action={
            <Button onClick={() => setInviteOpen(true)} data-testid="open-invite-dialog">
              {t('invite')}
            </Button>
          }
        >
          {t('title')}
        </SectionRule>

        {actionError !== undefined ? (
          <Alert variant="destructive" data-testid="user-role-error">
            <AlertDescription>{messageForCode(actionError.code)}</AlertDescription>
          </Alert>
        ) : null}

        <UserListFilters params={params} setParams={setParams} />

        {usersQuery.isPending ? (
          <LoadingState label={t('loading')} variant="skeleton" rows={5} />
        ) : usersQuery.isError ? (
          <ErrorState title={t('loadFailed')} onRetry={() => void usersQuery.refetch()} />
        ) : usersQuery.data.users.length === 0 ? (
          <EmptyState
            title={filtered ? t('noMatchTitle') : t('emptyTitle')}
            description={filtered ? t('noMatchDescription') : undefined}
          />
        ) : (
          <>
            <Table narrow="list" aria-busy={usersQuery.isPlaceholderData} data-testid="user-table">
              <TableCaption className="sr-only">{t('caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <SortableHead
                    column="name"
                    sort={params.sort}
                    order={params.order}
                    onSort={onSort}
                  >
                    {t('columns.name')}
                  </SortableHead>
                  <SortableHead
                    column="email"
                    sort={params.sort}
                    order={params.order}
                    onSort={onSort}
                  >
                    {t('columns.email')}
                  </SortableHead>
                  <TableHead>{t('columns.role')}</TableHead>
                  <SortableHead
                    column="workspaceCount"
                    sort={params.sort}
                    order={params.order}
                    onSort={onSort}
                    defaultOrder="desc"
                  >
                    {t('columns.workspaces')}
                  </SortableHead>
                  <SortableHead
                    column="lastSessionAt"
                    sort={params.sort}
                    order={params.order}
                    onSort={onSort}
                    defaultOrder="desc"
                  >
                    {t('columns.lastActive')}
                  </SortableHead>
                  <SortableHead
                    column="createdAt"
                    sort={params.sort}
                    order={params.order}
                    onSort={onSort}
                    defaultOrder="desc"
                  >
                    {t('columns.registered')}
                  </SortableHead>
                  <TableHead className="sr-only">{t('columns.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersQuery.data.users.map((user) => {
                  const isSelf = user.id === currentUserId;
                  const disabled = user.disabledAt !== null;
                  return (
                    <TableRow key={user.id} className={disabled ? 'opacity-60' : undefined}>
                      <TableCell cell="title">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{user.name}</span>
                          {isSelf ? <Badge variant="secondary">{t('you')}</Badge> : null}
                          {disabled ? (
                            <Badge variant="outline" data-testid={`user-disabled-${user.id}`}>
                              {t('disabled')}
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell label={t('columns.email')} className="text-muted-foreground">
                        {user.email}
                      </TableCell>
                      <TableCell label={t('columns.role')}>
                        <Select
                          value={user.role}
                          disabled={isSelf || busy}
                          onValueChange={(next) =>
                            updateRole.mutate({
                              userId: user.id,
                              request: { role: next as UserRole },
                            })
                          }
                        >
                          <SelectTrigger aria-label={t('roleOf', { name: user.name })} size="sm">
                            {/* Base UI shows the raw value ("admin") without this. */}
                            <SelectValue>{() => roleLabel(user.role)}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="user">{roleLabel('user')}</SelectItem>
                            <SelectItem value="admin">{roleLabel('admin')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell label={t('columns.workspaces')}>{user.workspaceCount}</TableCell>
                      <TableCell label={t('columns.lastActive')}>
                        {user.lastSessionAt !== null
                          ? format.dateTime(new Date(user.lastSessionAt), {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })
                          : '–'}
                      </TableCell>
                      <TableCell label={t('columns.registered')}>
                        {format.dateTime(new Date(user.createdAt), { dateStyle: 'medium' })}
                      </TableCell>
                      <TableCell cell="actions">
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
                              {disabled ? t('activate') : t('deactivate')}
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
                                title={t('hasContentHint')}
                              >
                                {t('hasContent')}
                              </span>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => setPendingDeletion(user)}
                                data-testid={`delete-user-${user.id}`}
                              >
                                {t('delete')}
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
            <ListPager
              page={pageFrom(params.page)}
              pageSize={USER_PAGE_SIZE}
              total={usersQuery.data.total}
              onPage={(next) => setParams({ page: String(next) }, { keepPage: true })}
              testId="user-pager"
            />
          </>
        )}
      </section>

      <section className="flex flex-col gap-4 border-t border-border pt-8">
        <SectionRule>{t('invitations')}</SectionRule>
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
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteDescription', { email: pendingDeletion?.email ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDeletion(null)}>
              {t('cancel')}
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
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
