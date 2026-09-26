'use client';

import { ClockIcon, ListFilterIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type SearchResult } from '@exocortex/contracts';
import { type CommandItem, CommandPalette } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import {
  isLinkCommand,
  isMenuCommand,
  nestedCommands,
  nestedHint,
  PALETTE_GROUPS,
  type PaletteCommand,
  type PaletteGroup,
  paletteMatcher,
  resolveMenus,
} from '@/components/palette/palette-command';
import { useSavedQueries } from '@/lib/api/saved-query-queries';
import { useSearch } from '@/lib/api/search-queries';
import { useWorkspaceOverview } from '@/lib/api/workspace-queries';
import { documentHref } from '@/lib/document-href';

export interface SearchCommandProps {
  workspaceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Everything the palette can do or open (issues #115, #148). */
  commands: readonly PaletteCommand[];
}

/**
 * The hit's own line, with the section it came out of in front (issue #118).
 *
 * The innermost heading rather than the whole path: one row of a palette is
 * about sixty characters wide, and on a long page the last heading is the one
 * that says which part of it was found.
 */
function withSection(section: SearchResult['section'], snippet: string): string {
  const heading = section?.path[section.path.length - 1];
  return heading === undefined ? snippet : `${heading} · ${snippet}`;
}

/**
 * Command menu and full-text search in one surface.
 *
 * Search results come from the PostgreSQL adapter through
 * `GET /workspaces/:id/search`; snippets are produced server-side.
 *
 * What it shows before a key is pressed is the point (issue #115). It used to
 * show "Mindestens zwei Zeichen eingeben", which asks the reader to remember a
 * title before it will help -- in a product whose accessibility requirement is
 * that no surface may demand you remember where you were, and whose second
 * purpose after writing is finding things again. So an empty field now answers
 * with the pages last worked on: the one list that needs no memory at all, and
 * the same data the overview's "Weitermachen" is built from.
 *
 * The order says what a keystroke does. With nothing typed, the recent pages
 * come first, so Enter carries on where you left off rather than -- as it did
 * -- creating an untitled page. With something typed, whatever commands match
 * it come first, because typing a command's name is asking for the command;
 * the pages follow.
 */
export function SearchCommand({ workspaceId, open, onOpenChange, commands }: SearchCommandProps) {
  const router = useRouter();
  const t = useTranslations('search.command');
  const [query, setQuery] = React.useState('');
  // The command chosen, kept until the dialog has closed: see `onClosed`.
  const [pendingRun, setPendingRun] = React.useState<(() => void) | null>(null);
  // The ids of the menus entered, outermost first (issue #148).
  const [menuIds, setMenuIds] = React.useState<readonly string[]>([]);
  // Both only while the palette is open. The overview is usually already in the
  // cache from the workspace's landing page, so opening the palette costs
  // nothing; a workspace's stored questions are small but not worth a request
  // on every page load.
  const activeWorkspace = open && workspaceId !== null ? workspaceId : undefined;
  const savedQueries = useSavedQueries(activeWorkspace);
  const overview = useWorkspaceOverview(activeWorkspace);

  // Emptying the field on close: a palette that reopens holding the last
  // question would show yesterday's answer above today's recent pages.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open && query !== '') setQuery('');
    if (!open && menuIds.length > 0) setMenuIds([]);
  }

  const menus = React.useMemo(() => resolveMenus(commands, menuIds), [commands, menuIds]);
  const menu = menus[menus.length - 1];
  const enter = React.useCallback((id: string) => {
    setMenuIds((ids) => [...ids, id]);
    setQuery('');
  }, []);
  // Inside a menu the words are a filter, not a question for the index.
  const search = useSearch(workspaceId ?? undefined, menu === undefined ? query : '');

  const typed = query.trim().length > 0;

  const items = React.useMemo<CommandItem[]>(() => {
    const matches = paletteMatcher(query);
    const go = (href: string): void => {
      onOpenChange(false);
      router.push(href);
    };

    // One row for a command, wherever it was found. A menu is entered, a
    // link goes, anything else runs once the dialog has closed.
    const toItem = (command: PaletteCommand, group: string, hint = command.hint): CommandItem => {
      const base = { id: command.id, group, label: command.label, hint, icon: command.icon };
      if (isMenuCommand(command)) {
        return { ...base, submenu: true, onSelect: () => enter(command.id) };
      }
      if (isLinkCommand(command)) {
        const href = command.href;
        return { ...base, link: <Link href={href} />, onSelect: () => go(href) };
      }
      return {
        ...base,
        onSelect: () => {
          setPendingRun(() => command.run);
          onOpenChange(false);
        },
      };
    };

    // Inside a menu only its own choices, and typing searches everything
    // below it: "arch" in "Seite verschieben" finds the page three levels
    // down with the way to it as the hint. Pages, recent pages and saved
    // searches stay at the top, where the question is still open.
    if (menu !== undefined) {
      const level = menu.children();
      if (!typed) return level.map((command) => toItem(command, menu.label));
      const direct = level.filter((command) => matches(command.label, ...command.keywords));
      const below = nestedCommands(level, () => true)
        .filter((nested) => matches(nested.command.label, ...nested.command.keywords))
        .map((nested) =>
          toItem(nested.command, menu.label, nestedHint(nested) || nested.command.hint),
        );
      return [...direct.map((command) => toItem(command, menu.label)), ...below].slice(0, 50);
    }

    const actions: CommandItem[] = [];
    const groupLabel: Record<PaletteGroup, string> = {
      page: t('groupPage'),
      create: t('groupCreate'),
      actions: t('groupActions'),
      view: t('groupView'),
      navigation: t('groupNavigation'),
      settings: t('groupSettings'),
    };
    // Grouped by heading in this order whatever order the providers listed
    // them in, because `CommandPalette` draws a heading where its first row is.
    const ordered = PALETTE_GROUPS.flatMap((group) =>
      commands.filter((command) => command.group === group),
    );
    for (const command of ordered) {
      // Before a key is pressed only the handful marked for it; the rest
      // wait to be asked for by name.
      if (!typed && command.idle !== true) continue;
      if (matches(command.label, groupLabel[command.group], ...command.keywords)) {
        actions.push(toItem(command, groupLabel[command.group]));
      }
      // A menu of a few named choices answers with them too, so "breit" is
      // one Enter away and not two.
      if (typed && isMenuCommand(command) && command.searchable === true) {
        for (const nested of nestedCommands([command], (entered) => entered.searchable === true)) {
          if (!matches(nested.command.label, ...command.keywords, ...nested.command.keywords)) {
            continue;
          }
          actions.push(toItem(nested.command, groupLabel[command.group], nestedHint(nested)));
        }
      }
    }

    // The stored questions, so a saved search is reachable by name from the
    // same keystroke everything else is.
    const stored = (savedQueries.data?.savedQueries ?? [])
      .filter((savedQuery) => matches(savedQuery.name, savedQuery.description ?? ''))
      .map<CommandItem>((savedQuery) => {
        const href = `/arbeitsbereich/${savedQuery.workspaceId}/suche/${savedQuery.id}`;
        return {
          id: `saved-query-${savedQuery.id}`,
          group: t('groupSavedQueries'),
          label: savedQuery.name,
          hint: savedQuery.description ?? undefined,
          icon: <ListFilterIcon className="size-4 text-muted-foreground" />,
          link: <Link href={href} />,
          onSelect: () => go(href),
        };
      });

    // With nothing typed there is nothing to search for, so the palette answers
    // with the pages this workspace was last working on.
    const recent = typed
      ? []
      : (overview.data?.recentlyEdited ?? []).map<CommandItem>((document) => {
          const href = documentHref(workspaceId ?? '', document.id, document.type);
          return {
            id: `recent-${document.id}`,
            group: t('groupRecent'),
            label: document.title,
            // The path, because a workspace can hold three pages called
            // "Notizen" and a bare title makes the reader guess which one.
            hint:
              document.path.length === 0
                ? undefined
                : document.path.map((entry) => entry.title).join(' / '),
            icon: (
              <DocumentIcon
                icon={document.icon}
                iconColor={document.iconColor}
                type={document.type}
                className="text-muted-foreground"
              />
            ),
            link: <Link href={href} data-testid={`recent-result-${document.id}`} />,
            onSelect: () => go(href),
          };
        });

    const results = (search.data?.results ?? []).map<CommandItem>((result) => {
      const href = documentHref(result.workspaceId, result.documentId, result.type);
      return {
        id: result.documentId,
        group: t('groupPages'),
        label: result.title,
        hint: withSection(result.section, result.snippet.replace(/<\/?mark>/g, '').slice(0, 60)),
        icon: (
          <DocumentIcon
            icon={result.icon}
            iconColor={result.iconColor}
            type={result.type}
            className="text-muted-foreground"
          />
        ),
        // A real anchor, so a hit can be opened in a new tab or its address
        // copied; `onSelect` below is the same route for the keyboard.
        link: (
          <Link
            href={href}
            data-testid={`search-result-${result.documentId}`}
            onClick={(event) => {
              // A modified click opens a background tab: the palette is still
              // the surface the reader is working in and must stay open.
              if (event.ctrlKey || event.metaKey || event.shiftKey) return;
              onOpenChange(false);
            }}
          />
        ),
        onSelect: () => go(href),
      };
    });

    // Enter lands on the first row: carry on where you were when nothing is
    // typed, run the command you named when something is.
    return typed ? [...actions, ...stored, ...results] : [...recent, ...actions, ...stored];
  }, [
    commands,
    enter,
    menu,
    onOpenChange,
    overview.data,
    query,
    router,
    savedQueries.data,
    search.data,
    t,
    typed,
    workspaceId,
  ]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      items={items}
      trail={menus.map((entered) => entered.label)}
      onBack={(depth) => {
        setMenuIds((ids) => ids.slice(0, depth ?? ids.length - 1));
        setQuery('');
      }}
      placeholder={menu?.placeholder}
      onClosed={() => {
        // After the dialog has given focus back, so an action that focuses
        // the title or opens a popover is not undone by it.
        setPendingRun(null);
        pendingRun?.();
      }}
      emptyLabel={
        menu !== undefined
          ? (menu.empty ?? t('empty'))
          : query.trim().length === 1
            ? t('minimumLength')
            : t('empty')
      }
      footer={
        // A count, a duration and an engine name: a readout, so it gets the
        // instrument face. The fallback sentence is prose and stays sans.
        menu !== undefined ? (
          <span>{t('menuHint')}</span>
        ) : search.data !== undefined && query.trim().length > 1 ? (
          <span className="exocortex-numeric">
            {t('readout', {
              count: search.data.results.length,
              tookMs: search.data.tookMs,
              adapter: search.data.adapter,
            })}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <ClockIcon className="size-3.5" aria-hidden />
            {t('idleHint')}
          </span>
        )
      }
    />
  );
}
