'use client';

import { type DocumentShare } from '@exocortex/contracts';
import { Button } from '@exocortex/ui';

import { revokeConsequence } from './share-wording';

/**
 * The question asked before a grant is withdrawn from one of the lists.
 *
 * Inline beside the grant rather than a dialog, for the reasons the share
 * dialog gives: the sentence belongs next to what it is about, and on a phone
 * a modal has nowhere to go. Name what goes, name what cannot be undone, and
 * put focus on the safe half so a second Return never destroys anything.
 */
export function ShareRevokeConfirm({
  share,
  where,
  testIdPrefix,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  share: DocumentShare;
  where: 'dialog' | 'list';
  testIdPrefix: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-2 border-t border-border pt-2"
      data-testid={`${testIdPrefix}-revoke-confirm`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onCancel();
      }}
    >
      <p role="alert" className="text-sm">
        <span className="font-medium">Zurückziehen?</span>{' '}
        <span className="text-muted-foreground">{revokeConsequence(share, where)}</span>
      </p>
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive-text">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          autoFocus
          data-testid={`${testIdPrefix}-revoke-cancel`}
          onClick={onCancel}
        >
          Abbrechen
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={pending}
          data-testid={`${testIdPrefix}-revoke-confirm-button`}
          onClick={onConfirm}
        >
          {pending ? 'Wird zurückgezogen …' : 'Zurückziehen'}
        </Button>
      </div>
    </div>
  );
}
