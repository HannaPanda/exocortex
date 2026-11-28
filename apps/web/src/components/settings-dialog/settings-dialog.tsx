'use client';

import { ChevronLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  SectionRule,
  useIsMobile,
} from '@exocortex/ui';

import {
  UnsavedChangesDialog,
  UnsavedDraftReport,
} from '@/components/settings/unsaved-changes-guard';
import { isPlainClick } from '@/lib/plain-click';

import { settingsAddress, settingsRequestOf, type SettingsSectionId } from './sections';
import { SettingsDialogContext } from './settings-dialog-context';
import { type SettingsEntry, useSettingsEntries } from './settings-entries';

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
  const entries = useSettingsEntries();

  // A group the reader may not see (a workspace role that changed, a pasted
  // address) is answered with the first one they may, never with a group they
  // would only be refused in.
  const active = entries.find((entry) => entry.id === section) ?? null;
  const shown = active ?? (isMobile ? null : (entries[0] ?? null));

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

  const areas = groupByArea(entries);

  return (
    <Dialog
      open
      onOpenChange={(next: boolean) => {
        if (!next) guarded(onClose);
      }}
    >
      <DialogContent
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
        <nav
          aria-label={t('navigation')}
          className={cn(
            'flex w-64 shrink-0 flex-col border-r border-border bg-surface',
            'max-md:w-full max-md:border-r-0',
            isMobile && shown !== null && 'hidden',
          )}
        >
          <div className="flex flex-col gap-1 px-4 pt-4 pb-3">
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription className="exocortex-sr-only">{t('description')}</DialogDescription>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {areas.map(({ area, items }) => (
              <div key={area} className="mt-3 first:mt-0">
                <SectionRule as="h3" className="px-2 pb-1">
                  {t(`areas.${area}`)}
                </SectionRule>
                <ul className="flex flex-col gap-0.5">
                  {items.map((entry) => (
                    <li key={entry.id}>
                      <NavItem
                        entry={entry}
                        current={shown?.id === entry.id}
                        href={href(entry.id)}
                        onSelect={() => select(entry.id)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        {shown === null ? null : (
          <section
            aria-labelledby="settings-section-title"
            data-testid={`settings-section-${shown.id}`}
            className="relative min-w-0 flex-1 overflow-y-auto px-6 pt-6 pb-8"
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

function groupByArea(entries: readonly SettingsEntry[]) {
  const areas: { area: SettingsEntry['area']; items: SettingsEntry[] }[] = [];
  for (const entry of entries) {
    const last = areas.at(-1);
    if (last?.area === entry.area) last.items.push(entry);
    else areas.push({ area: entry.area, items: [entry] });
  }
  return areas;
}

/**
 * One group in the navigation: a real link, so it opens in a new tab and can
 * be copied, that switches the group in place on an ordinary click. "This one"
 * is marked the way the page tree marks the open page (DESIGN.md,
 * Navigation): the strong surface, full-strength text and an amber icon.
 */
function NavItem({
  entry,
  current,
  href,
  onSelect,
}: {
  entry: SettingsEntry;
  current: boolean;
  href: string;
  onSelect: () => void;
}) {
  const Icon = entry.icon;
  return (
    <Link
      href={href}
      replace
      scroll={false}
      aria-current={current ? 'page' : undefined}
      data-testid={`settings-nav-${entry.id}`}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onSelect();
      }}
      className={cn(
        'flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        'max-md:min-h-11',
        current
          ? 'bg-accent-strong font-medium text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <Icon className={cn('size-4 shrink-0', current && 'text-primary')} aria-hidden />
      <span className="truncate">{entry.label}</span>
    </Link>
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
