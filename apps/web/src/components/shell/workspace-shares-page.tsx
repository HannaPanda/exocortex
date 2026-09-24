'use client';

import { GlobeIcon, UserIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { type DocumentShare } from '@exocortex/contracts';
import {
  AppPage,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useRevokeWorkspaceShare, useWorkspaceShares } from '@/lib/api/share-queries';

import { ShareRevokeConfirm } from './share-revoke-confirm';
import { SHARE_STATE_LABELS, shareStateOf } from './share-wording';

const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });

/**
 * Everything this workspace has handed out (issue #83, ADR-044).
 *
 * The page that makes the feature reviewable. A share is made in a dialog on
 * one page and then forgotten about; without one list of all of them, "what is
 * public here" is a question nobody can answer, and the honest answer after a
 * year would be "we do not know".
 *
 * Withdrawn grants stay in the list rather than disappearing, because "this was
 * public until March" is part of the answer too.
 */
export function WorkspaceSharesPage({ workspaceId }: { workspaceId: string }) {
  const shares = useWorkspaceShares(workspaceId);
  const revoke = useRevokeWorkspaceShare(workspaceId);
  /** The share whose withdrawal is being confirmed, by id. At most one. */
  const [confirming, setConfirming] = React.useState<string | null>(null);

  if (shares.isPending) return <LoadingState label="Freigaben werden geladen …" />;
  if (shares.isError) {
    return (
      <ErrorState
        title="Freigaben konnten nicht geladen werden"
        onRetry={() => void shares.refetch()}
      />
    );
  }

  const rows = shares.data.shares;
  // Expiry is judged against the moment the answer arrived, not the render.
  const now = shares.dataUpdatedAt;

  return (
    <AppPage maxWidth="max-w-5xl">
      <h1 className="exocortex-page-title">Freigaben</h1>
      <p className="mt-1 max-w-measure text-sm text-muted-foreground">
        Was aus diesem Arbeitsbereich nach außen gegeben ist: an einzelne Konten und als
        öffentlicher Link. Zurückgezogene Freigaben bleiben stehen, damit nachvollziehbar bleibt,
        was einmal offen war.
      </p>

      {rows.length === 0 ? (
        <EmptyState
          className="mt-8"
          title="Nichts freigegeben"
          description="Keine Seite dieses Arbeitsbereichs ist von außen erreichbar."
        />
      ) : (
        <Table className="mt-8" data-testid="workspace-shares">
          <TableHeader>
            <TableRow>
              <TableHead>Seite</TableHead>
              <TableHead>An wen</TableHead>
              <TableHead>Recht</TableHead>
              <TableHead>Umfang</TableHead>
              <TableHead>Läuft ab</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((share) => (
              <React.Fragment key={share.id}>
                <TableRow data-testid="workspace-share-row" data-state={shareStateOf(share, now)}>
                  <TableCell>
                    <Link
                      href={`/arbeitsbereich/${workspaceId}/seite/${share.documentId}`}
                      className="font-medium hover:underline"
                    >
                      {share.documentTitle}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm">{recipientOf(share)}</TableCell>
                  <TableCell>
                    <Badge variant="muted">
                      {share.permission === 'WRITE' ? 'Bearbeiten' : 'Lesen'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {share.scope === 'SUBTREE' ? 'mit Unterseiten' : 'nur die Seite'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {share.expiresAt === null ? '–' : dateFormat.format(new Date(share.expiresAt))}
                  </TableCell>
                  <TableCell>
                    <Badge variant={shareStateOf(share, now) === 'active' ? 'default' : 'muted'}>
                      {SHARE_STATE_LABELS[shareStateOf(share, now)]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={share.revokedAt !== null || confirming === share.id}
                      data-testid="workspace-share-revoke"
                      aria-label={`Zurückziehen: ${share.documentTitle}`}
                      onClick={() => {
                        revoke.reset();
                        setConfirming(share.id);
                      }}
                    >
                      Zurückziehen
                    </Button>
                  </TableCell>
                </TableRow>
                {confirming === share.id ? (
                  <TableRow>
                    <TableCell colSpan={7} className="whitespace-normal">
                      <ShareRevokeConfirm
                        share={share}
                        where="list"
                        testIdPrefix="workspace-share"
                        pending={revoke.isPending}
                        error={
                          revoke.isError
                            ? revoke.error instanceof ApiError
                              ? messageForCode(revoke.error.code)
                              : 'Die Freigabe konnte nicht zurückgezogen werden.'
                            : null
                        }
                        onCancel={() => setConfirming(null)}
                        onConfirm={() =>
                          revoke.mutate(share.id, { onSuccess: () => setConfirming(null) })
                        }
                      />
                    </TableCell>
                  </TableRow>
                ) : null}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      )}
    </AppPage>
  );
}

function recipientOf(share: DocumentShare): React.ReactNode {
  if (share.kind === 'PUBLIC_LINK') {
    return (
      <span className="flex items-center gap-1.5">
        <GlobeIcon className="size-3.5" /> Öffentlicher Link
        <span className="font-mono text-xs text-muted-foreground">…{share.tokenPrefix ?? ''}</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <UserIcon className="size-3.5" /> {share.grantee?.email ?? 'Unbekannt'}
    </span>
  );
}
