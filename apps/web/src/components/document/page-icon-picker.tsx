'use client';

import { CheckIcon, SmilePlusIcon } from 'lucide-react';
import * as React from 'react';

import {
  DOCUMENT_ICON_COLORS,
  type DocumentIconColor,
  type DocumentSummary,
  type DocumentType,
} from '@exocortex/contracts';
import {
  Button,
  buttonVariants,
  cn,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@exocortex/ui';

import { useUpdateDocument } from '@/lib/api/document-queries';

import {
  DOCUMENT_ICON_COLOR_CLASS,
  DOCUMENT_ICON_COLOR_LABELS,
  DOCUMENT_ICON_GROUPS,
  DOCUMENT_ICON_KEYWORDS,
  DOCUMENT_ICON_LABELS,
  DocumentIcon,
  documentIconLabel,
  documentIconName,
  documentIconValue,
} from './document-icon';
import { EmojiPalette } from './emoji-palette';
import { searchIconNames } from './icon-search';
import { useLucideIconData } from './lucide-icon-store';
import { useRecentSymbols } from './recent-symbols';

export interface PageIconSelection {
  icon: string | null;
  iconColor: DocumentIconColor | null;
}

export interface PageIconPickerProps {
  icon: string | null;
  iconColor: DocumentIconColor | null;
  /** Only decides which default icon the trigger shows while nothing is picked. */
  type: DocumentType;
  onSelect: (selection: PageIconSelection) => void;
  trigger: React.ReactElement<Record<string, unknown>>;
  /**
   * Optional control from outside. The page tree needs it: its context menu has
   * to open the picker that belongs to a row, and the popover still has to be
   * anchored to that row's symbol.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * How much of "Alle Symbole" is drawn at once, and how much each scroll to the
 * bottom adds. 1,756 SVGs in one popover is several seconds of layout; a screen
 * holds forty.
 */
const ICON_PAGE_SIZE = 240;

/** How close to the bottom counts as "asking for more". */
const SCROLL_THRESHOLD_PX = 240;

/** The curated names, as a set, so "Alle Symbole" can leave out what is above it. */
const CURATED_ICON_NAMES: ReadonlySet<string> = new Set(
  DOCUMENT_ICON_GROUPS.flatMap((group) => [...group.names]),
);

/** Icon names whose German label or extra keywords contain the query. */
function filterCuratedIconGroups(
  query: string,
): readonly { label: string; names: readonly string[] }[] {
  const needle = query.trim().toLowerCase();
  return DOCUMENT_ICON_GROUPS.map((group) => ({
    label: group.label,
    names: group.names.filter(
      (name) =>
        needle.length === 0 ||
        DOCUMENT_ICON_LABELS[name].toLowerCase().includes(needle) ||
        name.includes(needle) ||
        (DOCUMENT_ICON_KEYWORDS[name] ?? []).some((keyword) => keyword.includes(needle)),
    ),
  })).filter((group) => group.names.length > 0);
}

/** The grid cell. */
function SymbolCell({
  label,
  selected,
  testId,
  onClick,
  children,
  className,
}: {
  label: string;
  selected: boolean;
  testId: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={selected}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        // A plain button carrying the Button component's classes rather than the
        // component itself: a grid can hold hundreds of these at once, and each
        // `Button` is a `useRender` call. Same pixels, a fraction of the work.
        buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
        selected && 'bg-accent-strong',
        className,
      )}
    >
      {children}
    </button>
  );
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-1 text-xs font-medium text-muted-foreground">{children}</p>;
}

/**
 * The body of the picker.
 *
 * Its own component so that it exists only while the popover is open. That is
 * what keeps the half-megabyte of Lucide path data and the 160 kB of emoji names
 * off the page: the tree renders one picker per row, and a hook that loads them
 * would fire once per row on the first paint.
 */
function PageIconPickerBody({
  icon,
  iconColor,
  type,
  onSelect,
  close,
}: {
  icon: string | null;
  iconColor: DocumentIconColor | null;
  type: DocumentType;
  onSelect: (selection: PageIconSelection) => void;
  close: () => void;
}) {
  const [query, setQuery] = React.useState('');
  const [color, setColor] = React.useState<DocumentIconColor | null>(iconColor);
  const [visibleIcons, setVisibleIcons] = React.useState(ICON_PAGE_SIZE);

  const iconData = useLucideIconData();
  const [recentIcons, rememberIcon] = useRecentSymbols('icon');

  const currentName = documentIconName(icon);
  const needle = query.trim();

  const curatedGroups = React.useMemo(() => filterCuratedIconGroups(query), [query]);
  const iconResults = React.useMemo(() => searchIconNames(query, iconData), [query, iconData]);

  /** Everything Lucide draws that is not already sitting in a group above. */
  const restIconNames = React.useMemo(
    () =>
      iconData === null
        ? []
        : Object.keys(iconData.nodes).filter((name) => !CURATED_ICON_NAMES.has(name)),
    [iconData],
  );

  const pickIcon = (name: string): void => {
    rememberIcon(name);
    onSelect({ icon: documentIconValue(name), iconColor: color });
    close();
  };

  const pickColor = (next: DocumentIconColor | null): void => {
    setColor(next);
    if (currentName !== null) onSelect({ icon, iconColor: next });
  };

  const iconCell = (name: string, testId: string): React.ReactNode => (
    <SymbolCell
      key={testId}
      label={documentIconLabel(name)}
      selected={currentName === name}
      testId={testId}
      onClick={() => pickIcon(name)}
    >
      <DocumentIcon icon={documentIconValue(name)} iconColor={color} type={type} />
    </SymbolCell>
  );

  const onIconScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    const box = event.currentTarget;
    if (box.scrollHeight - box.scrollTop - box.clientHeight > SCROLL_THRESHOLD_PX) return;
    setVisibleIcons((count) => Math.min(count + ICON_PAGE_SIZE, restIconNames.length));
  };

  return (
    <>
      <Input
        autoFocus
        value={query}
        aria-label="Symbol suchen"
        data-testid="page-icon-search"
        placeholder="Suchen …"
        onChange={(event) => {
          setQuery(event.target.value);
          setVisibleIcons(ICON_PAGE_SIZE);
        }}
      />

      <Tabs defaultValue="symbols" className="mt-2">
        <TabsList>
          <TabsTrigger value="symbols" data-testid="page-icon-tab-symbols">
            Symbole
          </TabsTrigger>
          <TabsTrigger value="emoji" data-testid="page-icon-tab-emoji">
            Emoji
          </TabsTrigger>
        </TabsList>

        <TabsContent value="symbols" className="mt-2">
          {/* The swatches carry a name and, when active, a check mark: colour is
              never the only thing that says which one is picked. */}
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Farbe">
            <button
              type="button"
              aria-label="Standardfarbe"
              aria-pressed={color === null}
              data-testid="page-icon-color-default"
              onClick={() => pickColor(null)}
              className={cn(
                'grid size-6 place-items-center rounded-md border border-border text-muted-foreground',
                'hover:border-border-strong',
                color === null && 'border-primary bg-accent',
              )}
            >
              {color === null ? (
                <CheckIcon className="size-3" />
              ) : (
                <span className="text-xs">A</span>
              )}
            </button>
            {DOCUMENT_ICON_COLORS.map((name) => (
              <button
                key={name}
                type="button"
                aria-label={DOCUMENT_ICON_COLOR_LABELS[name]}
                aria-pressed={color === name}
                data-testid={`page-icon-color-${name}`}
                onClick={() => pickColor(name)}
                className={cn(
                  'grid size-6 place-items-center rounded-md border border-border',
                  DOCUMENT_ICON_COLOR_CLASS[name],
                  'hover:border-border-strong',
                  color === name && 'border-primary bg-accent',
                )}
              >
                {color === name ? (
                  <CheckIcon className="size-3" />
                ) : (
                  <span aria-hidden className="size-3 rounded-full bg-current" />
                )}
              </button>
            ))}
          </div>

          <div className="mt-2 max-h-56 overflow-y-auto" onScroll={onIconScroll}>
            {needle.length > 0 ? (
              iconResults.length === 0 ? (
                <p className="px-1 py-2 text-sm text-muted-foreground">
                  {iconData === null ? 'Symbole werden geladen …' : 'Kein Symbol passt dazu.'}
                </p>
              ) : (
                <div className="grid grid-cols-8 gap-0.5">
                  {iconResults.map((name) => iconCell(name, `page-icon-${name}`))}
                </div>
              )
            ) : (
              <>
                {recentIcons.length > 0 ? (
                  <div>
                    <GroupHeading>Zuletzt verwendet</GroupHeading>
                    <div className="grid grid-cols-8 gap-0.5">
                      {recentIcons.map((name) => iconCell(name, `page-icon-recent-${name}`))}
                    </div>
                  </div>
                ) : null}

                {curatedGroups.map((group) => (
                  <div key={group.label}>
                    <GroupHeading>{group.label}</GroupHeading>
                    <div className="grid grid-cols-8 gap-0.5">
                      {group.names.map((name) => iconCell(name, `page-icon-${name}`))}
                    </div>
                  </div>
                ))}

                <div>
                  <GroupHeading>
                    Alle Symbole
                    {iconData === null ? ' werden geladen …' : ` (${restIconNames.length})`}
                  </GroupHeading>
                  <div className="grid grid-cols-8 gap-0.5">
                    {restIconNames
                      .slice(0, visibleIcons)
                      .map((name) => iconCell(name, `page-icon-${name}`))}
                  </div>
                </div>
              </>
            )}
          </div>
        </TabsContent>

        <TabsContent value="emoji" className="mt-2">
          <EmojiPalette
            query={query}
            selected={icon}
            testIdPrefix="page-icon-emoji"
            className="max-h-[17.5rem]"
            onPick={(char) => {
              // An emoji carries its own colours, so it clears the one that would
              // no longer be visible.
              onSelect({ icon: char, iconColor: null });
              close();
            }}
          />
        </TabsContent>
      </Tabs>

      {icon !== null ? (
        <Button
          variant="ghost"
          size="sm"
          data-testid="page-icon-remove"
          className="mt-2 w-full justify-start text-muted-foreground"
          onClick={() => {
            onSelect({ icon: null, iconColor: null });
            close();
          }}
        >
          Symbol entfernen
        </Button>
      ) : null}
    </>
  );
}

/**
 * Picks the symbol a page carries: an emoji, or a drawn icon in a colour.
 *
 * The two are separate tabs and not one mixed grid on purpose. Colour is the
 * reason: an emoji brings its own and ignores the palette, so a mixed grid would
 * be a picker in which half the colour buttons quietly do nothing. Two tabs make
 * the trade visible — pick an emoji and you pick its colours with it, pick a
 * drawn symbol and the colour is yours.
 *
 * Colour is applied the moment it is clicked when a drawn icon is already set,
 * so the palette can be tried out against the real page. With an emoji set it
 * only arms the colour for the icon picked next.
 *
 * Both sets are complete — every emoji, every Lucide icon — but neither opens
 * that way. What is on screen before anyone types is the curated shortlist and
 * the symbols this browser picked last, because that is what the next pick
 * almost always is. The thousands behind them are reached by searching, or by
 * scrolling past the shortlist into "Alle Symbole".
 */
export function PageIconPicker({
  icon,
  iconColor,
  type,
  onSelect,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: PageIconPickerProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);

  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean): void => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" className="w-80">
        {/* Mounted only while open, which is also what resets the query and the
            colour: the body holds both, so closing the popover throws them away
            and reopening starts from the page's own state again. */}
        {open ? (
          <PageIconPickerBody
            icon={icon}
            iconColor={iconColor}
            type={type}
            onSelect={onSelect}
            close={() => setOpen(false)}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

interface PageIconControlProps {
  workspaceId: string;
  document: Pick<DocumentSummary, 'id' | 'icon' | 'iconColor' | 'type'>;
}

/**
 * The page's own symbol above its title, and the way to change it.
 *
 * Large, because at the top of a page the icon is the second thing that says
 * which page this is; the tree renders the same symbol at text size.
 */
export function PageIconButton({
  workspaceId,
  document,
  readOnly,
}: PageIconControlProps & { readOnly: boolean }) {
  const updateDocument = useUpdateDocument(workspaceId);

  const icon = (
    <DocumentIcon
      icon={document.icon}
      iconColor={document.iconColor}
      type={document.type}
      // Not a rung of the type ladder: this sizes an emoji glyph to its 3rem
      // box, so the number belongs to the box and not to the text hierarchy.
      className="size-12 text-[2.75rem]"
    />
  );

  if (readOnly) return <div className="mb-1 flex">{icon}</div>;

  return (
    <div className="mb-1 flex">
      <PageIconPicker
        icon={document.icon}
        iconColor={document.iconColor}
        type={document.type}
        onSelect={(selection) => {
          void updateDocument.mutateAsync({ documentId: document.id, request: selection });
        }}
        trigger={
          <button
            type="button"
            aria-label="Symbol ändern"
            data-testid="page-icon-button"
            className="grid size-14 place-items-center rounded-md transition-colors hover:bg-accent"
          >
            {icon}
          </button>
        }
      />
    </div>
  );
}

/**
 * "Symbol hinzufügen" for a page that has none. Hidden until the page is hovered
 * for the same reason the cover button is: an empty page should not carry a
 * control for something it does not have.
 */
export function PageIconAddButton({ workspaceId, document }: PageIconControlProps) {
  const updateDocument = useUpdateDocument(workspaceId);

  return (
    <PageIconPicker
      icon={document.icon}
      iconColor={document.iconColor}
      type={document.type}
      onSelect={(selection) => {
        void updateDocument.mutateAsync({ documentId: document.id, request: selection });
      }}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          data-testid="add-page-icon"
          className="text-muted-foreground opacity-0 transition-opacity group-hover/page:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <SmilePlusIcon /> Symbol hinzufügen
        </Button>
      }
    />
  );
}
