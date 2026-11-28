'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
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
 * Whether this click is a navigation that would take the form off screen.
 *
 * Everything a browser treats as "not an ordinary link activation" is left
 * alone: a modified click opens a tab or a window and this page stays, a
 * download is not a navigation, and a link to the page we are already on
 * (including a bare fragment) loses nothing.
 */
function navigationTargetOf(event: MouseEvent, pageIsAsked: boolean): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const { target } = event;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a');
  if (anchor === null || anchor.getAttribute('href') === null) return null;
  if (anchor.target === '_blank' || anchor.hasAttribute('download')) return null;

  const destination = new URL(anchor.href, window.location.href);
  if (destination.origin !== window.location.origin) return null;
  // Inside the settings dialog a link to the same page with another query
  // switches its group, and the dialog asks about that itself; a second
  // question from here would stand on top of its own.
  if (pageIsAsked && destination.pathname === window.location.pathname) return null;
  if (
    destination.pathname === window.location.pathname &&
    destination.search === window.location.search
  ) {
    return null;
  }
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

/**
 * Where a draft reports how much of it is unsaved, when it sits inside a
 * surface that can close without a navigation (the settings dialog, issue
 * #279). Closing a dialog is not a click on a link, so the guard below cannot
 * see it; the dialog asks this instead before it lets the draft go.
 */
export const UnsavedDraftReport = React.createContext<((changedCount: number) => void) | null>(
  null,
);

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
export function useUnsavedChangesGuard(
  changedCount: number,
  /** What is lost, when it is not a count of settings (e.g. a workflow draft, issue #198). */
  description?: string,
): React.ReactNode {
  const router = useRouter();
  const t = useTranslations('settings.unsaved');
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);
  const dirty = changedCount > 0;
  const report = React.useContext(UnsavedDraftReport);

  React.useEffect(() => {
    if (report === null) return;
    report(changedCount);
    return () => report(0);
  }, [changedCount, report]);

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
      const href = navigationTargetOf(event, report !== null);
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
  }, [dirty, report]);

  return (
    <UnsavedChangesDialog
      open={pendingHref !== null}
      description={description ?? t('description', { count: changedCount })}
      onStay={() => setPendingHref(null)}
      onLeave={() => {
        const href = pendingHref;
        setPendingHref(null);
        if (href !== null) router.push(href);
      }}
    />
  );
}

/**
 * The question itself, for the guard above and for a surface that closes
 * without navigating (the settings dialog).
 */
export function UnsavedChangesDialog({
  open,
  description,
  onStay,
  onLeave,
}: {
  open: boolean;
  description: string;
  onStay: () => void;
  onLeave: () => void;
}) {
  const t = useTranslations('settings.unsaved');
  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        // Escape and the backdrop mean the same as "stay here": the safe
        // answer is the one an accidental dismissal gives.
        if (!next) onStay();
      }}
    >
      <DialogContent data-testid="unsaved-changes-dialog">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          {/* The shape is the one the trash sheet already asks in: the fact
              first, then the consequence, then the way out. A count rather than
              "changes" alone, because a settings form holds over a hundred rows
              across thirteen groups and "you have unsaved changes" tells
              somebody nothing about whether it was the one switch they just
              flipped or an afternoon's work. */}
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" data-testid="unsaved-changes-stay" onClick={onStay}>
            {t('stay')}
          </Button>
          <Button variant="destructive" data-testid="unsaved-changes-leave" onClick={onLeave}>
            {t('leave')}
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
  const t = useTranslations('settings.unsaved');
  return (
    <p role="status" data-testid={testId} className="text-sm text-muted-foreground">
      {changedCount === 0 ? '' : t('notice', { count: changedCount })}
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
        // On a phone the buttons share the bar's full width, so the one a
        // thumb reaches for is never a small target in a corner (P12).
        'max-sm:[&>:first-child]:w-full max-sm:[&>:first-child>*]:flex-1',
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
