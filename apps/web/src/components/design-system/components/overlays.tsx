'use client';

import {
  ChevronRightIcon,
  CopyIcon,
  FileTextIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SearchIcon,
  TrashIcon,
} from 'lucide-react';
import * as React from 'react';

import {
  Button,
  type CommandItem,
  CommandPalette,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  ImageLightbox,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import { DsExample, DsSection, DsState, DsStates } from '../showcase';

/** Menus, popovers, tooltips, dialogs and sheets: everything that floats. */

function PageMenuItems() {
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Seite</DropdownMenuLabel>
        <DropdownMenuItem>
          <PencilIcon />
          Umbenennen
        </DropdownMenuItem>
        <DropdownMenuItem>
          <CopyIcon />
          Duplizieren
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            Verschieben nach
            <ChevronRightIcon className="ml-auto size-3.5 opacity-60" />
          </DropdownMenuSubTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem>Projekte</DropdownMenuItem>
            <DropdownMenuItem>Notizen</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuSub>
        <DropdownMenuItem disabled>Als Vorlage speichern</DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive">
        <TrashIcon />
        In den Papierkorb
      </DropdownMenuItem>
    </>
  );
}

export function MenusSection() {
  return (
    <DsSection
      id="menues"
      title="Menüs und Popover"
      lead="Ein Eintrag, der etwas zerstört, steht nach einem Trenner am Ende und trägt die destruktive Variante. Jeder Hinweis-Tooltip wiederholt nur, was schon im aria-label steht."
    >
      <DsExample
        id="menue-aufklapp"
        title="Aufklappmenü"
        source="packages/ui/src/components/ui/dropdown-menu.tsx"
        note="Mit Gruppe, Beschriftung, Untermenü, deaktiviertem und destruktivem Eintrag."
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label="Seitenaktionen">
                <MoreHorizontalIcon />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="w-56">
            <PageMenuItems />
          </DropdownMenuContent>
        </DropdownMenu>
      </DsExample>

      <DsExample
        id="menue-kontext"
        title="Kontextmenü"
        source="packages/ui/src/components/ui/context-menu.tsx"
        note="Öffnet per Rechtsklick oder Umschalt+F10. Ohne sichtbaren Auslöser ist es auf dem Handy nur per langem Drücken erreichbar (Issue #129)."
      >
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border-strong text-sm text-muted-foreground">
                Hier rechts klicken
              </div>
            }
          />
          <ContextMenuContent className="w-52">
            <ContextMenuItem>Umbenennen</ContextMenuItem>
            <ContextMenuItem>Duplizieren</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive">Löschen</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </DsExample>

      <DsExample
        id="popover"
        title="Popover und Tooltip"
        source="packages/ui/src/components/ui/popover.tsx, tooltip.tsx"
      >
        <DsStates>
          <DsState label="Popover">
            <Popover>
              <PopoverTrigger render={<Button variant="outline">Link einfügen</Button>} />
              <PopoverContent align="start" className="w-72">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ds-popover-url">Adresse</Label>
                  <Input id="ds-popover-url" placeholder="https://…" />
                </div>
              </PopoverContent>
            </Popover>
          </DsState>
          <DsState label="Tooltip (auf Touch ausgeblendet)">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="Suchen">
                    <SearchIcon />
                  </Button>
                }
              />
              <TooltipContent>Suchen · Strg+K</TooltipContent>
            </Tooltip>
          </DsState>
        </DsStates>
      </DsExample>
    </DsSection>
  );
}

const PALETTE_PAGES = ['Wochenplanung', 'Protokoll Infrastruktur', 'Leseliste', 'Rezepte'];
const PALETTE_WIDTHS = ['Schmal', 'Breit', 'Volle Breite'];

export function DialogsSection() {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  // One menu deep is enough to show the trail and the way back.
  const [inLayout, setInLayout] = React.useState(false);
  const [lightboxOpen, setLightboxOpen] = React.useState(false);

  const matches = (title: string): boolean => title.toLowerCase().includes(query.toLowerCase());
  const closePalette = (open: boolean): void => {
    setPaletteOpen(open);
    if (!open) setInLayout(false);
  };
  const items: CommandItem[] = inLayout
    ? PALETTE_WIDTHS.filter(matches).map((width) => ({
        id: width,
        label: width,
        group: 'Layout ändern',
        hint: width === 'Schmal' ? 'aktuell' : undefined,
        onSelect: () => closePalette(false),
      }))
    : [
        ...(matches('Layout ändern')
          ? [
              {
                id: 'layout',
                label: 'Layout ändern',
                group: 'Diese Seite',
                submenu: true,
                onSelect: () => {
                  setInLayout(true);
                  setQuery('');
                },
              },
            ]
          : []),
        ...PALETTE_PAGES.filter(matches).map((title) => ({
          id: title,
          label: title,
          group: 'Seiten',
          icon: <FileTextIcon className="size-4" />,
          onSelect: () => closePalette(false),
        })),
      ];

  return (
    <DsSection
      id="dialoge"
      title="Dialoge und Sheets"
      lead="Erst die Alternativen im Fluss ausschöpfen, dann ein Modal. Im Fuß steht die sichere Antwort zuerst und die destruktive zuletzt, auf dem Handy untereinander in derselben Reihenfolge."
    >
      <DsExample
        id="dialog"
        title="Dialog"
        source="packages/ui/src/components/ui/dialog.tsx"
        note="Kopf, scrollender Körper, Fuß. Die Reihenfolge im Fuß prüft e2e/tests/dialog-footer.spec.ts."
      >
        <Button variant="outline" onClick={() => setDialogOpen(true)}>
          Dialog öffnen
        </Button>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Seite umbenennen</DialogTitle>
              <DialogDescription>
                Der neue Titel erscheint im Seitenbaum und in allen Verweisen.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ds-dialog-title">Titel</Label>
                <Input id="ds-dialog-title" defaultValue="Wochenplanung" />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Abbrechen
              </Button>
              <Button onClick={() => setDialogOpen(false)}>Speichern</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DsExample>

      <DsExample
        id="sheet"
        title="Sheet"
        source="packages/ui/src/components/ui/sheet.tsx"
        note="Von links die Navigation, von rechts Kontext und Papierkorb. Unter 768 px werden die Seitenbereiche der Hülle zu Sheets."
      >
        <Button variant="outline" onClick={() => setSheetOpen(true)}>
          Sheet öffnen
        </Button>
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="right" className="w-full max-w-xl">
            <SheetHeader>
              <SheetTitle>Papierkorb</SheetTitle>
              <SheetDescription>
                Was du in den Papierkorb legst, bleibt hier, bis es jemand wiederherstellt oder
                endgültig löscht.
              </SheetDescription>
            </SheetHeader>
            <ul className="flex flex-col px-4">
              {['Alte Notizen', 'Entwurf Q3'].map((title) => (
                <li
                  key={title}
                  className="flex items-center gap-2 border-t border-border py-2 text-sm"
                >
                  <FileTextIcon className="size-4 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`„${title}“ endgültig löschen`}
                  >
                    <TrashIcon />
                  </Button>
                </li>
              ))}
            </ul>
          </SheetContent>
        </Sheet>
      </DsExample>

      <DsExample
        id="befehlspalette"
        title="Befehlspalette"
        source="packages/ui/src/components/ui/command-palette.tsx"
        note="Combobox mit Listbox und aria-activedescendant: der Fokus bleibt im Feld, die Pfeiltasten wandern durch die Treffer. Ein Eintrag mit Pfeil ist ein Menü: er stellt eine zweite Frage, der gewählte Weg steht vor dem Feld, die Rücktaste im leeren Feld geht zurück."
      >
        <Button variant="outline" onClick={() => setPaletteOpen(true)}>
          <SearchIcon />
          Palette öffnen
        </Button>
        <CommandPalette
          open={paletteOpen}
          onOpenChange={closePalette}
          query={query}
          onQueryChange={setQuery}
          items={items}
          trail={inLayout ? ['Layout ändern'] : []}
          onBack={() => {
            setInLayout(false);
            setQuery('');
          }}
          placeholder={inLayout ? 'Welche Breite?' : 'Seite suchen …'}
          emptyLabel="Keine Treffer"
        />
      </DsExample>

      <DsExample
        id="bild-lightbox"
        title="Bild vergrößern"
        source="packages/ui/src/components/image-lightbox.tsx"
        note="Passt zuerst in den Bildschirm, ohne kleine Bilder aufzublasen. Zoom über Plus und Minus, Mausrad, Trackpad oder zwei Finger; ist das Bild größer als der Bildschirm, lässt es sich ziehen, aber nie aus dem Blick. 0 passt es wieder ein, Escape, das Kreuz oder ein Klick daneben schließen. Im Produkt öffnet ImageLightboxArea jedes eingebettete Bild so."
      >
        <button
          type="button"
          aria-label="Bild vergrößern: eXocortex-Zeichen"
          className="cursor-zoom-in rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={() => setLightboxOpen(true)}
        >
          {/* oxlint-disable-next-line nextjs/no-img-element --
              the component under demonstration draws a plain img too. */}
          <img src="/icons/icon-512.png" alt="eXocortex-Zeichen" className="size-24 rounded-md" />
        </button>
        <ImageLightbox
          image={lightboxOpen ? { src: '/icons/icon-512.png', alt: 'eXocortex-Zeichen' } : null}
          onClose={() => setLightboxOpen(false)}
        />
      </DsExample>
    </DsSection>
  );
}
