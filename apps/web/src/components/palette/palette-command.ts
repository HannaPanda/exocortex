import { type UserRole, type WorkspaceRole } from '@exocortex/contracts';

/**
 * Which heading a command stands under in the palette.
 *
 * Four and not one: once the palette can open forty places, "Aktionen" above
 * all of them says nothing about what Enter will do. Going somewhere, changing
 * a setting and doing something are three different promises.
 */
export type PaletteGroup = 'navigation' | 'settings' | 'actions' | 'view';

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

/** A command that does something here, without leaving the page. */
export interface PaletteRunCommand extends PaletteCommandBase {
  run: () => void;
}

export type PaletteCommand = PaletteLinkCommand | PaletteRunCommand;

export function isLinkCommand(command: PaletteCommand): command is PaletteLinkCommand {
  return 'href' in command;
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
