'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentShare, type ShareListResponse } from '@exocortex/contracts';
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
} from '@exocortex/ui';

import { ApiError, apiRequest } from '@/lib/api/client';
import { useMoveDocument } from '@/lib/api/document-queries';
import { messageForCode } from '@/lib/api/error-messages';
import { shareKeys } from '@/lib/api/share-queries';

interface Target {
  parentId: string | null;
  title: string;
}

/**
 * Moving a page to a place chosen by name, from the palette (issue #148).
 *
 * The same question `SuggestParentDialog` asks before a page lands in a
 * shared branch (issue #83, ADR-044): moving it there shares it, and nothing
 * about choosing a row in a list looks like sharing. A target that inherits
 * nothing moves straight away and no dialog appears; one that does stops and
 * says what it would hand over. A move the server refuses says why here too,
 * because the palette that started it has closed.
 */
export function useGuardedMove({
  workspaceId,
  documentId,
  title,
}: {
  workspaceId: string;
  documentId: string;
  title: string;
}): { propose: (target: Target) => void; dialog: React.ReactNode } {
  const t = useTranslations('dialogs.suggestParent');
  const tMove = useTranslations('dialogs.guardedMove');
  const queryClient = useQueryClient();
  const moveDocument = useMoveDocument(workspaceId);
  const [warning, setWarning] = React.useState<{
    target: Target;
    shares: DocumentShare[];
  } | null>(null);
  const [failed, setFailed] = React.useState(false);

  const move = (parentId: string | null): void => {
    setFailed(false);
    void moveDocument
      .mutateAsync({ documentId, request: { parentId } })
      .catch(() => setFailed(true));
  };

  const propose = (target: Target): void => {
    setWarning(null);
    // The workspace root inherits nothing by definition, so it never waits.
    if (target.parentId === null) {
      move(null);
      return;
    }
    const parentId = target.parentId;
    void queryClient
      .fetchQuery({
        queryKey: shareKeys.inherited(parentId),
        queryFn: () => apiRequest<ShareListResponse>(`/api/documents/${parentId}/inherited-shares`),
        staleTime: 0,
      })
      .then((inherited) => {
        if (inherited.inherited.length === 0) move(parentId);
        else setWarning({ target, shares: inherited.inherited });
      })
      .catch(() => setFailed(true));
  };

  const close = (): void => {
    setWarning(null);
    setFailed(false);
  };

  const dialog = (
    <Dialog
      open={warning !== null || failed}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent data-testid="guarded-move-dialog">
        <DialogHeader>
          <DialogTitle>{failed ? tMove('failedTitle') : tMove('title')}</DialogTitle>
          <DialogDescription>
            {warning !== null
              ? t('shareWarning', { target: warning.target.title, title })
              : messageForCode(
                  moveDocument.error instanceof ApiError ? moveDocument.error.code : undefined,
                )}
          </DialogDescription>
        </DialogHeader>
        {warning !== null ? (
          <Alert>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {warning.shares.map((share) => (
                  <li key={share.id}>
                    {share.kind === 'PUBLIC_LINK'
                      ? t('sharePublicLink')
                      : share.grantee === null
                        ? t('shareGranteeUnknown')
                        : t('shareGrantee', { email: share.grantee.email })}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {warning !== null ? t('cancel') : t('close')}
          </Button>
          {warning !== null ? (
            <Button
              variant="destructive"
              data-testid="guarded-move-confirm"
              onClick={() => {
                const parentId = warning.target.parentId;
                setWarning(null);
                move(parentId);
              }}
            >
              {t('moveAnyway')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { propose, dialog };
}
