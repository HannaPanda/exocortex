'use client';

import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import { type Invitation, type InvitationStatus } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LoadingState,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { useDestructiveConfirmDialog } from '@/components/editor/destructive-confirm';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import {
  type InvitationScope,
  useInvitations,
  useResendInvitation,
  useRevokeInvitation,
} from '@/lib/api/invitation-queries';

/**
 * Only "offen" gets a colour. The other three are history, and a list where
 * everything is highlighted highlights nothing.
 */
const STATUS_VARIANTS: Record<InvitationStatus, 'default' | 'secondary' | 'outline'> = {
  pending: 'default',
  accepted: 'secondary',
  revoked: 'outline',
  expired: 'outline',
};

export function InvitationTable({
  scope,
  showWorkspace = false,
}: {
  scope: InvitationScope;
  /** The admin list spans workspaces and needs the column; a workspace's own does not. */
  showWorkspace?: boolean;
}) {
  const t = useTranslations('invitations.table');
  const statusLabel = useTranslations('invitations.statuses');
  const roleLabel = useTranslations('invitations.table.roles');
  const format = useFormatter();
  const invitations = useInvitations(scope);
  const resend = useResendInvitation(scope);
  const revoke = useRevokeInvitation(scope);

  /** The link from the most recent resend. Shown until the row changes. */
  const [freshLink, setFreshLink] = React.useState<{ id: string; url: string } | null>(null);
  const [copied, setCopied] = React.useState(false);
  const confirmDialog = useDestructiveConfirmDialog();

  if (invitations.isPending) {
    return <LoadingState label={t('loading')} variant="skeleton" rows={3} />;
  }
  if (invitations.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void invitations.refetch()} />;
  }
  if (invitations.data.length === 0) {
    return <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />;
  }

  const mutationError =
    resend.error instanceof ApiError
      ? resend.error.code
      : revoke.error instanceof ApiError
        ? revoke.error.code
        : undefined;

  return (
    <div className="flex flex-col gap-4">
      {confirmDialog.element}
      {mutationError !== undefined ? (
        <Alert variant="destructive" data-testid="invitation-action-error">
          <AlertDescription>{messageForCode(mutationError)}</AlertDescription>
        </Alert>
      ) : null}

      {freshLink !== null ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <Label htmlFor="resent-invite-link">{t('freshLink')}</Label>
          <div className="flex gap-2">
            <Input id="resent-invite-link" readOnly value={freshLink.url} />
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(freshLink.url).then(() => setCopied(true));
              }}
            >
              {copied ? t('copied') : t('copy')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('freshLinkHint')}</p>
        </div>
      ) : null}

      <Table narrow="list">
        <TableCaption className="sr-only">{t('caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>{t('email')}</TableHead>
            <TableHead>{t('status')}</TableHead>
            {showWorkspace ? <TableHead>{t('workspace')}</TableHead> : null}
            <TableHead>{t('role')}</TableHead>
            <TableHead>{t('invitedBy')}</TableHead>
            <TableHead>{t('expiresAt')}</TableHead>
            <TableHead>{t('sent')}</TableHead>
            <TableHead className="sr-only">{t('actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invitations.data.map((invitation) => (
            <TableRow key={invitation.id}>
              <TableCell cell="title" className="font-medium">
                {invitation.email}
              </TableCell>
              <TableCell label={t('status')}>
                <Badge variant={STATUS_VARIANTS[invitation.status]}>
                  {statusLabel(invitation.status)}
                </Badge>
              </TableCell>
              {showWorkspace ? (
                <TableCell label={t('workspace')} className="text-muted-foreground">
                  {invitation.workspaceName ?? '–'}
                </TableCell>
              ) : null}
              <TableCell label={t('role')} className="text-muted-foreground">
                {invitation.workspaceRole === null ? '–' : roleLabel(invitation.workspaceRole)}
                {invitation.role === 'admin' ? (
                  <Badge variant="secondary" className="ml-2">
                    {t('admin')}
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell label={t('invitedBy')} className="text-muted-foreground">
                {invitation.invitedByName}
              </TableCell>
              <TableCell label={t('expiresAt')} className="text-muted-foreground">
                {format.dateTime(new Date(invitation.expiresAt), { dateStyle: 'medium' })}
              </TableCell>
              <TableCell label={t('sent')} className="text-muted-foreground">
                {invitation.lastSentAt === null
                  ? t('notDelivered')
                  : `${String(invitation.sentCount)}×`}
              </TableCell>
              <TableCell cell="actions">
                <InvitationActions
                  invitation={invitation}
                  pending={resend.isPending || revoke.isPending}
                  onResend={() => {
                    setCopied(false);
                    resend.mutate(invitation.id, {
                      onSuccess: (data) => setFreshLink({ id: invitation.id, url: data.url }),
                    });
                  }}
                  onRevoke={() => {
                    void confirmDialog
                      .confirm({
                        title: t('revokeTitle'),
                        description: t('revokeDescription', { email: invitation.email }),
                        confirmLabel: t('revoke'),
                      })
                      .then((confirmed) => {
                        if (!confirmed) return;
                        setFreshLink(null);
                        revoke.mutate(invitation.id);
                      });
                  }}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * An accepted invitation offers nothing: it became an account, and that account
 * is managed in the user list. Everything else can be sent again, and anything
 * still live can be withdrawn.
 */
function InvitationActions({
  invitation,
  pending,
  onResend,
  onRevoke,
}: {
  invitation: Invitation;
  pending: boolean;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const t = useTranslations('invitations.table');
  if (invitation.status === 'accepted') {
    return <span className="text-xs text-muted-foreground">–</span>;
  }

  return (
    <div className="flex justify-end gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={onResend}
        data-testid={`resend-invitation-${invitation.id}`}
      >
        {t('resend')}
      </Button>
      {invitation.status === 'pending' ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={onRevoke}
          data-testid={`revoke-invitation-${invitation.id}`}
        >
          {t('revoke')}
        </Button>
      ) : null}
    </div>
  );
}
