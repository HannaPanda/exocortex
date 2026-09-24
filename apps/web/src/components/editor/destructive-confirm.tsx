'use client';

import * as React from 'react';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@exocortex/ui';

/** What the dialog asks and what it warns about. */
export interface DestructiveConfirmRequest {
  /** Names the action, for example „Tabelle löschen?“. */
  title: string;
  /** Says what disappears. */
  description: string;
  /** The verb on the confirming button, „Löschen“ unless the action is another one. */
  confirmLabel?: string;
}

/** Resolves `true` when the person confirmed, `false` on cancel or escape. */
export type ConfirmDestructive = (request: DestructiveConfirmRequest) => Promise<boolean>;

const DestructiveConfirmContext = React.createContext<ConfirmDestructive | null>(null);

/**
 * The confirmation for destructive actions: the editor's (issue #91), and the
 * admin, settings and database rows that removed something on one click (#129).
 *
 * It lives above the toolbars rather than inside them because every caller is a
 * bubble menu or a drag handle, and each of those unmounts the moment focus
 * leaves the text: a dialog rendered there would close itself while being
 * opened. `EditorChrome` renders `element` once and hands `confirm` down through
 * the context below.
 */
export function useDestructiveConfirmDialog(): {
  confirm: ConfirmDestructive;
  element: React.ReactNode;
} {
  const [pending, setPending] = React.useState<DestructiveConfirmRequest | null>(null);
  const resolveRef = React.useRef<((confirmed: boolean) => void) | null>(null);

  /** One place to leave the dialog, so no caller is ever left waiting. */
  const settle = React.useCallback((confirmed: boolean): void => {
    setPending(null);
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(confirmed);
  }, []);

  const confirm = React.useCallback<ConfirmDestructive>(
    (request) => {
      // A second request while one is open answers the first with a cancel:
      // nothing is destroyed by a question that was never seen.
      resolveRef.current?.(false);
      setPending(request);
      return new Promise<boolean>((resolve) => {
        resolveRef.current = resolve;
      });
    },
    [setPending],
  );

  const element = (
    <Dialog
      open={pending !== null}
      onOpenChange={(open: boolean) => {
        if (!open) settle(false);
      }}
    >
      <DialogContent data-testid="destructive-confirm">
        <DialogHeader>
          <DialogTitle>{pending?.title ?? ''}</DialogTitle>
          <DialogDescription>{pending?.description ?? ''}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" data-testid="destructive-cancel" onClick={() => settle(false)}>
            Abbrechen
          </Button>
          <Button
            variant="destructive"
            data-testid="destructive-confirm-button"
            onClick={() => settle(true)}
          >
            {pending?.confirmLabel ?? 'Löschen'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, element };
}

export const DestructiveConfirmProvider = DestructiveConfirmContext.Provider;

/**
 * The confirmation an editor toolbar asks with.
 *
 * Without a provider it answers `true`: a missing wrapper must not make a
 * deletion impossible, and the editor always has one.
 */
export function useDestructiveConfirm(): ConfirmDestructive {
  return React.useContext(DestructiveConfirmContext) ?? CONFIRM_WITHOUT_DIALOG;
}

const CONFIRM_WITHOUT_DIALOG: ConfirmDestructive = () => Promise.resolve(true);
