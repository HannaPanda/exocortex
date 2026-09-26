import { type UserRole, type WorkspaceRole } from '@exocortex/contracts';

/**
 * Which heading a command stands under in the palette.
 *
 * Several and not one: once the palette can open forty places, "Aktionen"
 * above all of them says nothing about what Enter will do. Acting on the open
 * page, making something new, going somewhere and changing a setting are
 * different promises. The order here is the order of the headings.
 */
export const PALETTE_GROUPS = [
  'page',
  'create',
  'actions',
  'view',
  'navigation',
  'settings',
] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

interface PaletteCommandBase {
  /** Stable, and unique across every provider: it is the row's React key. */
  id: string;
  group: PaletteGroup;
  label: string;
  /** The keystroke that does the same thing, or where the target lives. */
  hint?: string;
  icon: React.ReactNode;
  /** Words somebody might type instead of the label, from the catalogue. */
  keywords: readonly string[];
  /**
   * Offered before anything is typed. Off by default, because an empty field
   * answers with the recent pages (issue #115) and forty places underneath
   * them would bury the one list that needs no memory.
   */
  idle?: boolean;
}

/** A command that goes somewhere: the palette renders it as a real link. */
export interface PaletteLinkCommand extends PaletteCommandBase {
  href: string;
}

/**
 * A command that does something here, without leaving the page. It runs once
 * the palette has closed and handed focus back, so it may move focus itself.
 */
export interface PaletteRunCommand extends PaletteCommandBase {
  run: () => void;
}

/**
 * A command that asks a second question: "Layout ändern" and then which one,
 * "Seite verschieben" and then where (issue #148). Choosing it keeps the
 * palette open and lists `children` instead; Backspace in the empty field
 * goes back up. A child may be a menu itself, which is how a page tree is
 * walked one level at a time.
 */
export interface PaletteMenuCommand extends PaletteCommandBase {
  /** Asked for when the menu is entered, so it lists what is true by then. */
  children: () => readonly PaletteCommand[];
  /**
   * Its choices also answer what is typed a level above: "breit" finds
   * "Layout ändern → Breit" without the detour. Right for a handful of named
   * choices, wrong for a page tree, which would flood every search.
   */
  searchable?: boolean;
  /** What the field says once the menu is entered. */
  placeholder?: string;
  /** What an empty menu says, "Keine Vorlagen" rather than "Keine Treffer". */
  empty?: string;
}

export type PaletteCommand = PaletteLinkCommand | PaletteRunCommand | PaletteMenuCommand;

export function isLinkCommand(command: PaletteCommand): command is PaletteLinkCommand {
  return 'href' in command;
}

export function isMenuCommand(command: PaletteCommand): command is PaletteMenuCommand {
  return 'children' in command;
}

/**
 * The menus a list of ids leads through, outermost first.
 *
 * The palette keeps the ids it entered, not the menus: a menu's children are
 * read again on every render, so a list that was still loading when it was
 * entered fills in, and an id that has gone away ends the way there.
 */
export function resolveMenus(
  commands: readonly PaletteCommand[],
  ids: readonly string[],
): PaletteMenuCommand[] {
  const menus: PaletteMenuCommand[] = [];
  let level = commands;
  for (const id of ids) {
    const menu = level.find((command) => command.id === id);
    if (menu === undefined || !isMenuCommand(menu)) break;
    menus.push(menu);
    level = menu.children();
  }
  return menus;
}

/** A choice found below the level it is shown on, with the menus it is under. */
export interface NestedCommand {
  command: PaletteLinkCommand | PaletteRunCommand;
  /** The labels of the menus between the level searched and the choice. */
  path: readonly string[];
}

/**
 * Every choice below `commands`, depth first, with the way to it.
 *
 * Only the choices, not the menus: a menu found by name is entered, a choice
 * found by name is done, and searching is asking for the second. `descend`
 * says which menus are opened; `limit` stops a large tree from being read
 * to the end for a list of which only the top is shown.
 */
export function nestedCommands(
  commands: readonly PaletteCommand[],
  descend: (menu: PaletteMenuCommand) => boolean,
  limit = 200,
): NestedCommand[] {
  const found: NestedCommand[] = [];
  const walk = (level: readonly PaletteCommand[], path: readonly string[]): void => {
    for (const command of level) {
      if (found.length >= limit) return;
      if (!isMenuCommand(command)) {
        if (path.length > 0) found.push({ command, path });
      } else if (descend(command)) {
        walk(command.children(), [...path, command.label]);
      }
    }
  };
  walk(commands, []);
  return found;
}

/**
 * The way to a nested choice as a hint, "Projekte / eXocortex".
 *
 * A choice that repeats its menu's name is that menu's own ("Projekte" first
 * under "Projekte" moves the page into it), so the name is not said twice.
 */
export function nestedHint({ command, path }: NestedCommand): string {
  const shown = path[path.length - 1] === command.label ? path.slice(0, -1) : path;
  return shown.join(' / ');
}

/**
 * What a provider may ask about the surface the palette was opened on.
 *
 * A provider decides from this alone whether a command makes sense, so the
 * decision sits beside the command rather than in the palette: a room that
 * needs a workspace says so where it is declared (issue #148).
 */
export interface PaletteContext {
  workspaceId: string | null;
  documentId: string | null;
  /** The account's deployment role; `admin` opens the Verwaltung. */
  role: UserRole;
  /** The account's role in the open workspace, once it is known. */
  workspaceRole: WorkspaceRole | null;
}

/** Search words live in one message each, separated by spaces. */
export function keywordsOf(text: string): readonly string[] {
  return text.split(/\s+/).filter((word) => word.length > 0);
}

/**
 * A route pattern with its workspace filled in.
 *
 * The patterns are the spelling `check-palette-coverage.mjs` reads (`:x` for a
 * dynamic segment), so the address a command opens and the screen it claims
 * cannot be two strings that drift apart.
 */
export function fillScreen(screen: string, workspaceId: string | null): string {
  return screen.replace(':x', workspaceId ?? '');
}

/**
 * Whether a row answers what has been typed. An empty field matches all.
 *
 * Word by word, and every word has to be found somewhere in the row: "einst
 * ki" is the KI settings, because "einst" is in one of its words and "ki" in
 * another. Matching the whole phrase as one string would answer that with
 * nothing, and a person does not type in the order the label was written.
 */
export function paletteMatcher(query: string): (...haystack: readonly string[]) => boolean {
  const needles = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (needles.length === 0) return () => true;
  return (...haystack) => {
    const words = haystack.map((text) => text.toLowerCase());
    return needles.every((needle) => words.some((text) => text.includes(needle)));
  };
}
