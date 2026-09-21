'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@exocortex/ui';

/**
 * What the question says, given how much is at stake.
 *
 * The shape is the one the trash sheet already asks in: the fact first, then
 * the consequence, then the way out. A count rather than "Änderungen" alone,
 * because a settings form holds over a hundred rows across thirteen groups and
 * "you have unsaved changes" tells somebody nothing about whether it was the
 * one switch they just flipped or an afternoon's work.
 */
function describe(count: number): string {
  const subject =
    count === 1
      ? 'Eine Einstellung ist geändert und noch nicht gespeichert'
      : `${count} Einstellungen sind geändert und noch nicht gespeichert`;
  return `${subject}. Wer jetzt wechselt, verliert sie; das lässt sich nicht rückgängig machen. Hier bleiben und speichern behält sie.`;
}

/**
 * Whether this click is a navigation that would take the form off screen.
 *
 * Everything a browser treats as "not an ordinary link activation" is left
 * alone: a modified click opens a tab or a window and this page stays, a
 * download is not a navigation, and a link to the page we are already on
 * (including a bare fragment) loses nothing.
 */
function navigationTargetOf(event: MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const { target } = event;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a');
  if (anchor === null || anchor.getAttribute('href') === null) return null;
  if (anchor.target === '_blank' || anchor.hasAttribute('download')) return null;

  const destination = new URL(anchor.href, window.location.href);
  if (destination.origin !== window.location.origin) return null;
  if (
    destination.pathname === window.location.pathname &&
    destination.search === window.location.search
  ) {
    return null;
  }
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

/**
 * Asks before unsaved settings are thrown away (issue #113).
 *
 * A settings form keeps its whole draft in the browser and sends it in one
 * request, deliberately: `ai.enabled` or `automations.enabled` is a decision
 * rather than a draft, and half of a hundred saved values would be worse than
 * none. The price of that is that leaving the page loses everything, which it
 * did silently -- no question, no hint, no way back.
 *
 * Three exits, and this closes the two that can be closed:
 *
 * - A link inside the application is caught in the capture phase, before
 *   `next/link` sees the click. `onNavigate` on the link itself would only
 *   cover the links this form renders, and the ones that take you away are the
 *   admin tabs, the top bar, the account menu and the whole page tree.
 * - Closing the tab, reloading, or typing another address raises
 *   `beforeunload`, and only while something would actually be lost -- a
 *   dialog that appears when nothing is at stake is one people learn to click
 *   away.
 *
 * The third is the browser's own back button inside the application. It cannot
 * be caught here: the platform offers no cancellable event for it, and by the
 * time `popstate` arrives the router has already begun replacing this form, so
 * there is nothing left to ask about. `beforeunload` does cover a back that
 * leaves the application altogether.
 */
export function useUnsavedChangesGuard(changedCount: number): React.ReactNode {
  const router = useRouter();
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);
  const dirty = changedCount > 0;

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  React.useEffect(() => {
    if (!dirty) return;
    const intercept = (event: MouseEvent): void => {
      const href = navigationTargetOf(event);
      if (href === null) return;
      // `preventDefault` and nothing more. `next/link` checks
      // `defaultPrevented` before it navigates, so that is enough to hold the
      // click -- and stopping the event would also stop the menu or the sheet
      // the link was inside from closing, leaving its inert backdrop over a
      // page nobody had left.
      event.preventDefault();
      setPendingHref(href);
    };
    // Capture, because `next/link` listens on the anchor itself and a listener
    // that bubbles would arrive after the navigation had already started.
    document.addEventListener('click', intercept, true);
    return () => document.removeEventListener('click', intercept, true);
  }, [dirty]);

  return (
    <Dialog
      open={pendingHref !== null}
      onOpenChange={(open: boolean) => {
        // Escape and the backdrop mean the same as "Hier bleiben": the safe
        // answer is the one an accidental dismissal gives.
        if (!open) setPendingHref(null);
      }}
    >
      <DialogContent data-testid="unsaved-changes-dialog">
        <DialogHeader>
          <DialogTitle>Ungespeicherte Änderungen verwerfen?</DialogTitle>
          <DialogDescription>{describe(changedCount)}</DialogDescription>
        </DialogHeader>
        {/* `flex-col` against the footer's own `flex-col-reverse`: that default
            exists to put the action people came for under the thumb, and here
            that action is staying. Reversed, the phone showed "Verwerfen und
            wechseln" directly under the sentence warning about it. */}
        <DialogFooter className="flex-col sm:flex-row">
          <Button
            variant="outline"
            data-testid="unsaved-changes-stay"
            onClick={() => setPendingHref(null)}
          >
            Hier bleiben
          </Button>
          <Button
            variant="destructive"
            data-testid="unsaved-changes-leave"
            onClick={() => {
              const href = pendingHref;
              setPendingHref(null);
              if (href !== null) router.push(href);
            }}
          >
            Verwerfen und wechseln
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The line that says something is unsaved, for the form itself.
 *
 * An enabled save button is not a statement: it is the absence of one, and it
 * sits at the bottom of a form several screen heights long. This is a live
 * region, so the count reaches a screen reader too -- it changes only when a
 * setting starts or stops differing from what is stored, never per keystroke.
 */
export function UnsavedChangesNotice({
  changedCount,
  testId,
}: {
  changedCount: number;
  testId: string;
}) {
  return (
    <p role="status" data-testid={testId} className="text-sm text-muted-foreground">
      {changedCount === 0
        ? ''
        : changedCount === 1
          ? 'Eine Änderung ist noch nicht gespeichert.'
          : `${changedCount} Änderungen sind noch nicht gespeichert.`}
    </p>
  );
}

/**
 * The row the save and discard buttons stand in.
 *
 * It pins itself to the bottom of the page while something is unsaved, and
 * only then. A settings form is over a hundred rows long, so the row that says
 * what is pending and the button that resolves it were several screen heights
 * below the switch somebody had just flipped -- on a phone, out of sight
 * entirely. Pinned always would spend that space on every visit to a form
 * nobody is editing; pinned while it matters costs nothing the rest of the
 * time, and the transparent border keeps the height from changing as it
 * arrives.
 *
 * The negative margin reaches the edges of `AppPage`'s own padding, which is
 * the scroll container both settings forms sit directly inside.
 */
export function SettingsActionBar({
  dirty,
  children,
}: {
  dirty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        '-mx-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-transparent px-6 py-3',
        // The negative offset and the padding that answers it: `AppPage` is the
        // scroll container and it has 2rem of bottom padding, which a sticky
        // box stops above -- leaving a strip of the form showing underneath the
        // bar, which reads as the bar floating rather than sitting on the edge.
        // The negative bottom margin keeps the page from growing by the same
        // 2rem at the end of the scroll.
        dirty && 'sticky -bottom-8 -mb-8 border-border bg-background pb-11',
      )}
    >
      {children}
    </div>
  );
}
