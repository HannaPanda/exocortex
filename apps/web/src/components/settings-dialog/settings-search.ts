import { paletteMatcher } from '@/components/palette/palette-command';

/**
 * Something the settings dialog's search can find: a group of the dialog, or
 * a page that stays a page and is reached from it (issue #279).
 */
export interface SettingsSearchDoc {
  /** Unique across the list. */
  key: string;
  label: string;
  /**
   * The search words the palette uses for the same target, from the same
   * message: one list of words, read by both (CLAUDE.md rule 16).
   */
  keywords: readonly string[];
  /** The names of the single options inside, as the catalogue writes them. */
  options: readonly string[];
}

export interface SettingsSearchHit<T extends SettingsSearchDoc> {
  doc: T;
  /** The option the words were found in, when they were not in the doc's own name. */
  option: string | null;
}

/**
 * The documents that answer `query`, in their order, each with the option
 * that answered it when the document's own name and search words did not.
 *
 * Word by word like the palette (`paletteMatcher`): every typed word has to
 * be found in the label, a search word or one option. An option is named
 * beside the hit when it holds all the words, because "Jev" finding
 * "Konfiguration" says nothing until the line under it says "Werkzeuge mit
 * Jev auswählen". Nothing typed finds nothing: an empty search is not a
 * question, and the navigation is showing then anyway.
 */
export function searchSettings<T extends SettingsSearchDoc>(
  docs: readonly T[],
  query: string,
): SettingsSearchHit<T>[] {
  if (query.trim() === '') return [];
  const matches = paletteMatcher(query);
  const hits: SettingsSearchHit<T>[] = [];
  for (const doc of docs) {
    if (!matches(doc.label, ...doc.keywords, ...doc.options)) continue;
    const own = matches(doc.label, ...doc.keywords);
    const option = own ? null : (doc.options.find((candidate) => matches(candidate)) ?? null);
    hits.push({ doc, option });
  }
  return hits;
}
