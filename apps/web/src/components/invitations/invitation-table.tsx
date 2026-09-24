'use client';

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

const STATUS_LABELS: Record<InvitationStatus, string> = {
  pending: 'Offen',
  accepted: 'Angenommen',
  revoked: 'Zurückgezogen',
  expired: 'Abgelaufen',
};

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

const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });

export function InvitationTable({
  scope,
  showWorkspace = false,
}: {
  scope: InvitationScope;
  /** The admin list spans workspaces and needs the column; a workspace's own does not. */
  showWorkspace?: boolean;
}) {
  const invitations = useInvitations(scope);
  const resend = useResendInvitation(scope);
  const revoke = useRevokeInvitation(scope);

  /** The link from the most recent resend. Shown until the row changes. */
  const [freshLink, setFreshLink] = React.useState<{ id: string; url: string } | null>(null);
  const [copied, setCopied] = React.useState(false);
  const confirmDialog = useDestructiveConfirmDialog();

  if (invitations.isPending) {
    return <LoadingState label="Einladungen werden geladen …" variant="skeleton" rows={3} />;
  }
  if (invitations.isError) {
    return (
      <ErrorState
        title="Einladungen konnten nicht geladen werden"
        onRetry={() => void invitations.refetch()}
      />
    );
  }
  if (invitations.data.length === 0) {
    return (
      <EmptyState
        title="Keine Einladungen"
        description="Wer hier ankommen soll, braucht eine Einladung. Registrieren ohne eine ist abgeschaltet."
      />
    );
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
          <Label htmlFor="resent-invite-link">Neuer Einladungslink</Label>
          <div className="flex gap-2">
            <Input id="resent-invite-link" readOnly value={freshLink.url} />
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(freshLink.url).then(() => setCopied(true));
              }}
            >
              {copied ? 'Kopiert' : 'Kopieren'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Der vorherige Link gilt nicht mehr. Jedes erneute Verschicken erzeugt einen neuen.
          </p>
        </div>
      ) : null}

      <Table>
        <TableCaption className="sr-only">Einladungen</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>E-Mail</TableHead>
            <TableHead>Status</TableHead>
            {showWorkspace ? <TableHead>Arbeitsbereich</TableHead> : null}
            <TableHead>Rolle</TableHead>
            <TableHead>Eingeladen von</TableHead>
            <TableHead>Gültig bis</TableHead>
            <TableHead>Verschickt</TableHead>
            <TableHead className="sr-only">Aktionen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invitations.data.map((invitation) => (
            <TableRow key={invitation.id}>
              <TableCell className="font-medium">{invitation.email}</TableCell>
              <TableCell>
                <Badge variant={STATUS_VARIANTS[invitation.status]}>
                  {STATUS_LABELS[invitation.status]}
                </Badge>
              </TableCell>
              {showWorkspace ? (
                <TableCell className="text-muted-foreground">
                  {invitation.workspaceName ?? '–'}
                </TableCell>
              ) : null}
              <TableCell className="text-muted-foreground">
                {invitation.workspaceRole ?? '–'}
                {invitation.role === 'admin' ? (
                  <Badge variant="secondary" className="ml-2">
                    Admin
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className="text-muted-foreground">{invitation.invitedByName}</TableCell>
              <TableCell className="text-muted-foreground">
                {dateFormat.format(new Date(invitation.expiresAt))}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {invitation.lastSentAt === null ? 'nicht angekommen' : `${invitation.sentCount}×`}
              </TableCell>
              <TableCell>
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
                        title: 'Einladung zurückziehen?',
                        description: `Der Link an ${invitation.email} funktioniert danach nicht mehr. Soll die Person doch kommen, braucht sie eine neue Einladung.`,
                        confirmLabel: 'Zurückziehen',
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
        Erneut senden
      </Button>
      {invitation.status === 'pending' ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={onRevoke}
          data-testid={`revoke-invitation-${invitation.id}`}
        >
          Zurückziehen
        </Button>
      ) : null}
    </div>
  );
}
