'use client';

import { ChevronLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { Button, cn, Dialog, DialogContent, LoadingState, useIsMobile } from '@exocortex/ui';

import {
  UnsavedChangesDialog,
  UnsavedDraftReport,
} from '@/components/settings/unsaved-changes-guard';
import { useSessionQuery } from '@/lib/api/session-queries';
import { isPlainClick } from '@/lib/plain-click';

import { settingsAddress, settingsRequestOf, type SettingsSectionId } from './sections';
import { SettingsDialogContext } from './settings-dialog-context';
import { type SettingsEntry, useSettingsEntries } from './settings-entries';
import { SettingsNav } from './settings-nav';
import { useSettingsWorkspace } from './use-settings-workspace';

/** The page's address without the dialog, the part Back returns to. */
function plainAddress(location: Location): string {
  return settingsAddress(location, null);
}

/**
 * The settings dialog and the address it lives at (issue #279).
 *
 * The open group is the address, `?einstellungen=<group>` on whatever page is
 * open, so the dialog lies over the work instead of replacing it, a link or a
 * palette command lands straight in a group, and a reload keeps it. The
 * address is changed through the browser's own history API, which Next.js
 * folds into its router without a server round trip -- the same arrangement
 * the side peek of a database row uses (issue #239).
 *
 * Opening adds one step to the history and choosing another group replaces
 * it, so Back closes the dialog rather than walking through every group that
 * was looked at. A dialog the browser arrived at directly (a pasted address,
 * a redirect from an old settings page) has no step of its own to go back
 * over, and closing it only removes the parameter.
 */
export function SettingsDialogProvider({ children }: { children: React.ReactNode }) {
  const search = useSearchParams();
  const pathname = usePathname();
  const request = settingsRequestOf(search);
  const isOpen = request.open;

  /** Whether the open dialog added the step Back would remove. */
  const pushed = React.useRef(false);
  /** The last address seen with the dialog closed. */
  const lastPlain = React.useRef<string | null>(null);
  const wasOpen = React.useRef(isOpen);
  React.useEffect(() => {
    const plain = plainAddress(window.location);
    if (isOpen && !wasOpen.current && !pushed.current) {
      // Opened by a link rather than by `open` (the palette, a link in a
      // panel): it was a step of its own exactly when the page underneath is
      // the one that was showing a moment ago.
      pushed.current = lastPlain.current === plain;
    }
    if (!isOpen) {
      pushed.current = false;
      lastPlain.current = plain;
    }
    wasOpen.current = isOpen;
  }, [isOpen, pathname, search]);

  const open = React.useCallback((section: SettingsSectionId | '') => {
    const address = settingsAddress(window.location, section);
    if (settingsRequestOf(new URLSearchParams(window.location.search)).open) {
      window.history.replaceState(null, '', address);
      return;
    }
    lastPlain.current = plainAddress(window.location);
    pushed.current = true;
    window.history.pushState(null, '', address);
  }, []);

  const close = React.useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
      return;
    }
    window.history.replaceState(null, '', plainAddress(window.location));
  }, []);

  const searchString = search.toString();
  const href = React.useCallback(
    (section: SettingsSectionId | '') =>
      settingsAddress({ pathname, search: searchString }, section),
    [pathname, searchString],
  );

  const control = React.useMemo(() => ({ open, href }), [open, href]);

  return (
    <SettingsDialogContext.Provider value={control}>
      {children}
      {isOpen ? (
        <SettingsDialog section={request.section} onSelect={open} onClose={close} href={href} />
      ) : null}
    </SettingsDialogContext.Provider>
  );
}

/**
 * Which group the dialog shows. A group the reader may not see (a workspace
 * role that changed, a pasted address) is answered with the first one they
 * may, never with a group they would only be refused in; a phone shows the
 * list instead. Until the workspace and the account's role have arrived, a
 * group that may still turn out to be theirs is waited for, so a link to
 * "Mitglieder" does not flash "Sprache" first.
 */
function shownGroup({
  entries,
  section,
  pending,
  isMobile,
}: {
  entries: readonly SettingsEntry[];
  section: SettingsSectionId | null;
  pending: boolean;
  isMobile: boolean;
}): { shown: SettingsEntry | null; waiting: boolean } {
  const active = entries.find((entry) => entry.id === section) ?? null;
  if (active !== null) return { shown: active, waiting: false };
  if (section !== null && pending) return { shown: null, waiting: true };
  return { shown: isMobile ? null : (entries[0] ?? null), waiting: false };
}

function SettingsDialog({
  section,
  onSelect,
  onClose,
  href,
}: {
  section: SettingsSectionId | null;
  onSelect: (section: SettingsSectionId | '') => void;
  onClose: () => void;
  href: (section: SettingsSectionId | '') => string;
}) {
  const t = useTranslations('settings.dialog');
  const tUnsaved = useTranslations('settings.unsaved');
  const isMobile = useIsMobile();
  const session = useSessionQuery();
  const chosen = useSettingsWorkspace();
  const admin = session.data?.user?.role === 'admin';
  const entries = useSettingsEntries({ admin, workspace: chosen.workspace });
  const router = useRouter();
  const [query, setQuery] = React.useState('');

  const { shown, waiting } = shownGroup({
    entries,
    section,
    pending: chosen.pending || session.isPending,
    isMobile,
  });

  // How much of an open form is unsaved, so closing or switching can ask.
  const [unsaved, setUnsaved] = React.useState(0);
  const [pendingExit, setPendingExit] = React.useState<(() => void) | null>(null);
  const guarded = React.useCallback(
    (exit: () => void) => {
      if (unsaved > 0) setPendingExit(() => exit);
      else exit();
    },
    [unsaved],
  );

  const select = (id: SettingsSectionId | '') => guarded(() => onSelect(id));

  // The search field takes the focus on a desktop, where typing is the
  // fastest way in; a phone would raise its keyboard over the list somebody
  // opened the dialog to look at, so there the dialog itself holds the focus.
  const popup = React.useRef<HTMLDivElement>(null);

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (next) return;
        // Escape empties a search first and closes the dialog only after,
        // the way a search field anywhere else behaves.
        if (details.reason === 'escape-key' && query !== '') {
          setQuery('');
          return;
        }
        guarded(onClose);
      }}
    >
      <DialogContent
        ref={popup}
        initialFocus={(type) => (isMobile || type === 'touch' ? popup.current : true)}
        data-testid="settings-dialog"
        className={cn(
          'flex-row gap-0 overflow-hidden p-0',
          'h-[min(46rem,calc(100dvh-2rem))] max-w-5xl',
          // A phone gets the whole screen: a dialog one gutter short of the
          // edges leaves a strip of page nobody can use, and the list and the
          // group take turns instead of standing side by side.
          'max-md:top-0 max-md:left-0 max-md:h-dvh max-md:max-h-none max-md:w-full',
          'max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0',
          'max-md:rounded-none max-md:border-0',
        )}
      >
        <SettingsNav
          entries={entries}
          shownId={shown?.id ?? null}
          href={href}
          onSelect={select}
          onOpenPage={(target) => guarded(() => router.push(target))}
          query={query}
          onQuery={setQuery}
          admin={admin}
          workspaces={chosen.workspaces}
          workspaceId={chosen.workspaceId}
          onPickWorkspace={(id) => guarded(() => chosen.pick(id))}
          className={cn(isMobile && (shown !== null || waiting) && 'hidden')}
        />

        {waiting ? (
          <div className="flex min-w-0 flex-1 items-center justify-center">
            <LoadingState label={t('loading')} />
          </div>
        ) : null}

        {shown === null ? null : (
          <section
            // A group of another workspace starts from that workspace's
            // values, not from the drafts of the one before.
            key={`${shown.area === 'workspace' ? (chosen.workspaceId ?? '') : ''}:${shown.id}`}
            aria-labelledby="settings-section-title"
            data-testid={`settings-section-${shown.id}`}
            className="relative min-w-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-6 pb-8"
          >
            <UnsavedDraftReport.Provider value={setUnsaved}>
              <SectionView
                entry={shown}
                onBack={isMobile ? () => select('') : null}
                backHref={href('')}
              />
            </UnsavedDraftReport.Provider>
          </section>
        )}

        <UnsavedChangesDialog
          open={pendingExit !== null}
          description={tUnsaved('description', { count: unsaved })}
          onStay={() => setPendingExit(null)}
          onLeave={() => {
            const exit = pendingExit;
            setPendingExit(null);
            setUnsaved(0);
            exit?.();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function SectionView({
  entry,
  onBack,
  backHref,
}: {
  entry: SettingsEntry;
  /** On a phone, the way back to the list. */
  onBack: (() => void) | null;
  backHref: string;
}) {
  const t = useTranslations('settings.dialog');
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1 pe-8">
        {onBack === null ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="-ms-2 mb-2 self-start"
            data-testid="settings-back-to-list"
            render={
              <Link
                href={backHref}
                replace
                scroll={false}
                onClick={(event) => {
                  if (!isPlainClick(event)) return;
                  event.preventDefault();
                  onBack();
                }}
              />
            }
          >
            <ChevronLeftIcon /> {t('backToList')}
          </Button>
        )}
        <h2 id="settings-section-title" className="text-subsection">
          {entry.label}
        </h2>
        {entry.intro === null ? null : (
          <p className="max-w-measure text-sm text-muted-foreground">{entry.intro}</p>
        )}
      </header>
      {entry.render()}
    </div>
  );
}
