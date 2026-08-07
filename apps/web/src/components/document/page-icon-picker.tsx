'use client';

import { CheckIcon, SmilePlusIcon } from 'lucide-react';
import * as React from 'react';

import {
  DOCUMENT_ICON_COLORS,
  type DocumentIconColor,
  type DocumentIconName,
  type DocumentSummary,
  type DocumentType,
} from '@exocortex/contracts';
import {
  Button,
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

import { useUpdateDocument } from '@/lib/api/queries';
import { filterEmojiGroups } from '@/lib/emoji-catalog';

import {
  DOCUMENT_ICON_COLOR_CLASS,
  DOCUMENT_ICON_COLOR_LABELS,
  DOCUMENT_ICON_GROUPS,
  DOCUMENT_ICON_KEYWORDS,
  DOCUMENT_ICON_LABELS,
  DocumentIcon,
  documentIconName,
  documentIconValue,
} from './document-icon';

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

/** Icon names whose label or extra keywords contain the query. */
function filterIconGroups(query: string): readonly { label: string; names: DocumentIconName[] }[] {
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
  const [query, setQuery] = React.useState('');
  const [color, setColor] = React.useState<DocumentIconColor | null>(iconColor);

  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean): void => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  // Re-sync with the page whenever the picker opens, without an effect (React's
  // documented reset-on-change pattern).
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setColor(iconColor);
      setQuery('');
    }
  }

  const emojiGroups = React.useMemo(() => filterEmojiGroups(query), [query]);
  const iconGroups = React.useMemo(() => filterIconGroups(query), [query]);
  const currentName = documentIconName(icon);

  const pickColor = (next: DocumentIconColor | null): void => {
    setColor(next);
    if (currentName !== null) onSelect({ icon, iconColor: next });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" className="w-80">
        <Input
          autoFocus
          value={query}
          aria-label="Symbol suchen"
          data-testid="page-icon-search"
          placeholder="Suchen …"
          onChange={(event) => setQuery(event.target.value)}
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
                {color === null ? <CheckIcon className="size-3" /> : <span className="text-xs">A</span>}
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

            <div className="mt-2 max-h-56 overflow-y-auto">
              {iconGroups.length === 0 ? (
                <p className="px-1 py-2 text-sm text-muted-foreground">Kein Symbol passt dazu.</p>
              ) : (
                iconGroups.map((group) => (
                  <div key={group.label}>
                    <p className="px-1 py-1 text-xs font-medium text-muted-foreground">
                      {group.label}
                    </p>
                    <div className="grid grid-cols-8 gap-0.5">
                      {group.names.map((name) => (
                        <Button
                          key={name}
                          variant="ghost"
                          size="icon-sm"
                          aria-label={DOCUMENT_ICON_LABELS[name]}
                          aria-pressed={currentName === name}
                          data-testid={`page-icon-${name}`}
                          className={cn(currentName === name && 'bg-accent-strong')}
                          onClick={() => {
                            onSelect({ icon: documentIconValue(name), iconColor: color });
                            setOpen(false);
                          }}
                        >
                          <DocumentIcon
                            icon={documentIconValue(name)}
                            iconColor={color}
                            type={type}
                          />
                        </Button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </TabsContent>

          <TabsContent value="emoji" className="mt-2">
            <div className="max-h-[17.5rem] overflow-y-auto">
              {emojiGroups.length === 0 ? (
                <p className="px-1 py-2 text-sm text-muted-foreground">Kein Emoji passt dazu.</p>
              ) : (
                emojiGroups.map((group) => (
                  <div key={group.label}>
                    <p className="px-1 py-1 text-xs font-medium text-muted-foreground">
                      {group.label}
                    </p>
                    <div className="grid grid-cols-8 gap-0.5">
                      {group.emojis.map((emoji) => (
                        <Button
                          key={emoji.char}
                          variant="ghost"
                          size="icon-sm"
                          aria-label={emoji.keywords[0] ?? emoji.char}
                          aria-pressed={icon === emoji.char}
                          data-testid={`page-icon-emoji-${emoji.char}`}
                          className={cn('text-base', icon === emoji.char && 'bg-accent-strong')}
                          onClick={() => {
                            // An emoji carries its own colours, so it clears the
                            // one that would no longer be visible.
                            onSelect({ icon: emoji.char, iconColor: null });
                            setOpen(false);
                          }}
                        >
                          {emoji.char}
                        </Button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
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
              setOpen(false);
            }}
          >
            Symbol entfernen
          </Button>
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
