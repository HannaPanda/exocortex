'use client';

import { SearchIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type Workspace } from '@exocortex/contracts';
import { cn, DialogDescription, DialogTitle, Input, SectionRule } from '@exocortex/ui';

import { isPlainClick } from '@/lib/plain-click';

import { type SettingsSectionId } from './sections';
import { type SettingsEntry } from './settings-entries';
import { searchSettings, type SettingsSearchHit } from './settings-search';
import { type DialogSearchDoc, useSettingsSearchDocs } from './settings-search-docs';
import { SettingsWorkspacePicker } from './use-settings-workspace';

const ITEM_CLASS = cn(
  'flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm',
  'max-md:min-h-11',
);

/**
 * The dialog's left column: its title, the search field, and either the
 * groups by area or, while something is typed, what the search found
 * (issue #279).
 *
 * The search reads the palette's names and search words for the same
 * targets (`useSettingsSearchDocs`), so typing a word here and in `Strg + K`
 * finds the same thing; on top of that it knows the names of the single
 * settings a group holds, which the palette leaves to the group.
 */
export function SettingsNav({
  entries,
  shownId,
  href,
  onSelect,
  onOpenPage,
  query,
  onQuery,
  admin,
  workspaces,
  workspaceId,
  onPickWorkspace,
  className,
}: {
  entries: readonly SettingsEntry[];
  shownId: SettingsSectionId | null;
  href: (section: SettingsSectionId) => string;
  onSelect: (section: SettingsSectionId) => void;
  /** A hit that is a page of its own, chosen with the keyboard. */
  onOpenPage: (href: string) => void;
  query: string;
  onQuery: (query: string) => void;
  admin: boolean;
  workspaces: readonly Workspace[];
  workspaceId: string | null;
  onPickWorkspace: (workspaceId: string) => void;
  className?: string;
}) {
  const t = useTranslations('settings.dialog');
  const docs = useSettingsSearchDocs({ entries, workspaceId, admin });
  const searching = query.trim() !== '';
  const hits = React.useMemo(() => searchSettings(docs, query), [docs, query]);

  const choose = (hit: SettingsSearchHit<DialogSearchDoc>): void => {
    onQuery('');
    if (hit.doc.target.kind === 'section') onSelect(hit.doc.target.id);
    else onOpenPage(hit.doc.target.href);
  };

  return (
    <nav
      aria-label={t('navigation')}
      className={cn(
        'flex w-64 shrink-0 flex-col border-r border-border bg-surface',
        'max-md:w-full max-md:border-r-0',
        className,
      )}
    >
      <div className="flex flex-col gap-3 px-4 pt-4 pb-3">
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription className="exocortex-sr-only">{t('description')}</DialogDescription>
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            name="settings-search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter takes the first hit, the way the palette does.
              if (event.key !== 'Enter' || hits[0] === undefined) return;
              event.preventDefault();
              choose(hits[0]);
            }}
            placeholder={t('search.placeholder')}
            aria-label={t('search.label')}
            className="ps-8 max-md:min-h-11"
            data-testid="settings-search"
          />
        </div>
        <p className="exocortex-sr-only" aria-live="polite">
          {searching ? t('search.count', { count: hits.length }) : ''}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4">
        {searching ? (
          <SearchResults hits={hits} query={query} href={href} onChoose={choose} />
        ) : (
          groupByArea(entries).map(({ area, items }) => (
            <div key={area} className="mt-3 first:mt-0">
              <SectionRule as="h3" className="px-2 pb-1">
                {t(`areas.${area}`)}
              </SectionRule>
              {area === 'workspace' ? (
                <SettingsWorkspacePicker
                  workspaces={workspaces}
                  workspaceId={workspaceId}
                  onPick={onPickWorkspace}
                />
              ) : null}
              <ul className="flex flex-col gap-0.5">
                {items.map((entry) => (
                  <li key={entry.id}>
                    <NavItem
                      entry={entry}
                      current={shownId === entry.id}
                      href={href(entry.id)}
                      onSelect={() => onSelect(entry.id)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </nav>
  );
}

function SearchResults({
  hits,
  query,
  href,
  onChoose,
}: {
  hits: readonly SettingsSearchHit<DialogSearchDoc>[];
  query: string;
  href: (section: SettingsSectionId) => string;
  onChoose: (hit: SettingsSearchHit<DialogSearchDoc>) => void;
}) {
  const t = useTranslations('settings.dialog.search');
  if (hits.length === 0) {
    return (
      <p className="px-2 pt-2 text-sm text-muted-foreground" data-testid="settings-search-none">
        {t('none', { query: query.trim() })}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5" aria-label={t('results')}>
      {hits.map((hit) => {
        const { doc } = hit;
        const target = doc.target.kind === 'section' ? href(doc.target.id) : doc.target.href;
        return (
          <li key={doc.key}>
            <Link
              href={target}
              replace={doc.target.kind === 'section'}
              scroll={false}
              data-testid={`settings-search-hit-${doc.key}`}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                onChoose(hit);
              }}
              className={cn(
                ITEM_CLASS,
                'items-start text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <doc.icon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-foreground">{doc.label}</span>
                {hit.option === null ? null : (
                  <span className="truncate text-xs">{hit.option}</span>
                )}
              </span>
              {doc.hint === null ? null : (
                <span className="shrink-0 pt-0.5 text-xs">{doc.hint}</span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
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
        ITEM_CLASS,
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
