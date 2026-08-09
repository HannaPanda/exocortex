'use client';

import { useRender } from '@base-ui-components/react/use-render';
import { SearchIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../lib/utils';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  /** Section heading this item belongs to. */
  group: string;
  /**
   * The anchor an item that merely navigates is wrapped in — pass
   * `<Link href="…" />`, the same `render` convention `Button` uses.
   *
   * A palette entry that goes somewhere has to *be* a link, not a row that
   * happens to call the router: middle click, Strg-/Cmd-click, "open in new
   * tab" from the context menu and copying the address are all things the
   * browser does for free with an anchor and cannot be re-earned with an
   * `onClick` (issue #29). `onSelect` stays for the keyboard path, which is
   * what the palette is really for; the anchor is the addition, not the
   * replacement.
   */
  link?: useRender.RenderProp<React.ComponentPropsWithRef<'a'>>;
}

/** The row body: rendered plain, or inside whatever anchor `link` supplies. */
function CommandItemBody({
  link,
  children,
}: {
  link?: useRender.RenderProp<React.ComponentPropsWithRef<'a'>>;
  children: React.ReactNode;
}) {
  return useRender({
    render: link ?? <div />,
    props: {
      // The input keeps the focus, so the anchor must stay out of the tab order.
      tabIndex: -1,
      className: 'flex min-w-0 flex-1 items-center gap-2 text-inherit no-underline',
      children,
    },
  });
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  items: CommandItem[];
  placeholder?: string;
  emptyLabel?: string;
  footer?: React.ReactNode;
}

/**
 * Keyboard-first command menu.
 *
 * Built on the Base UI dialog plus a listbox implemented here, because the
 * combobox primitive assumes a single value while this palette dispatches
 * actions. Full keyboard support: arrows, Home/End, Enter, Escape.
 */
export function CommandPalette({
  open,
  onOpenChange,
  query,
  onQueryChange,
  items,
  placeholder = 'Suchen oder Befehl eingeben …',
  emptyLabel = 'Keine Treffer',
  footer,
}: CommandPaletteProps) {
  // The active item is tracked by id, not by index: when the result list changes
  // the id simply stops matching and the first item becomes active again. That
  // keeps the state derived instead of resetting it from an effect.
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const listId = React.useId();

  const groups = React.useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    for (const item of items) {
      const existing = map.get(item.group);
      if (existing === undefined) map.set(item.group, [item]);
      else existing.push(item);
    }
    return [...map.entries()];
  }, [items]);

  const flat = groups.flatMap(([, groupItems]) => groupItems);
  const knownIndex = flat.findIndex((item) => item.id === activeId);
  const activeIndex = knownIndex === -1 ? 0 : knownIndex;
  const activeItem = flat[activeIndex];

  const moveTo = (index: number): void => {
    const item = flat[index];
    if (item !== undefined) setActiveId(item.id);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (flat.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveTo((activeIndex + 1) % flat.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveTo((activeIndex - 1 + flat.length) % flat.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      moveTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      moveTo(flat.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activeItem?.onSelect();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-24 max-w-xl translate-y-0 gap-0 overflow-hidden p-0"
        showCloseButton={false}
      >
        <DialogTitle className="exocortex-sr-only">Befehlspalette</DialogTitle>
        <DialogDescription className="exocortex-sr-only">
          Seiten suchen und Befehle ausführen
        </DialogDescription>

        <div className="flex items-center gap-2 border-b border-border px-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeItem !== undefined ? `${listId}-${activeItem.id}` : undefined}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <ul id={listId} role="listbox" className="max-h-80 overflow-y-auto p-1">
          {flat.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyLabel}</li>
          ) : (
            groups.map(([group, groupItems]) => (
              <li key={group} role="presentation">
                <p className="px-2 pt-2 pb-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
                  {group}
                </p>
                <ul role="presentation">
                  {groupItems.map((item) => {
                    const index = flat.indexOf(item);
                    const active = index === activeIndex;
                    return (
                      <li
                        key={item.id}
                        id={`${listId}-${item.id}`}
                        role="option"
                        aria-selected={active}
                        onMouseEnter={() => setActiveId(item.id)}
                        // An item with an anchor is navigated by the anchor
                        // itself; a second `onSelect` here would push the route
                        // a second time and undo the modifier the click carried.
                        onClick={item.link === undefined ? () => item.onSelect() : undefined}
                        className={cn(
                          'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                          item.link === undefined ? 'cursor-default' : 'cursor-pointer',
                          // The palette is driven by arrow keys, so the active row
                          // has to be findable at a glance, not merely tinted.
                          active
                            ? 'bg-accent-strong font-medium text-foreground'
                            : 'text-muted-foreground',
                        )}
                      >
                        <CommandItemBody link={item.link}>
                          {item.icon}
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          {item.hint !== undefined ? (
                            <span className="shrink-0 truncate text-xs text-muted-foreground">
                              {item.hint}
                            </span>
                          ) : null}
                        </CommandItemBody>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))
          )}
        </ul>

        {footer !== undefined ? (
          <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            {footer}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
