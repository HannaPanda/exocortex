import { type MediaDocumentInfo } from './media-info';

/**
 * The words the editor's hand-built node views show (issue #98, ADR-062).
 *
 * This package runs on the server too and knows no locale, so it keeps the
 * German source as its default and the browser hands in the words of its
 * reader through `buildEditorExtensions({ words })`, from the `editor.nodeViews`
 * message namespace. The React node views (database, saved query,
 * transclusion, page link) and the block catalogue are translated where they
 * are drawn and have no entry here.
 *
 * Counts and dates are functions, because the plural and the order of day and
 * month belong to the language rather than to the caller.
 */
export interface EditorWords {
  media: {
    open: string;
    download: string;
    /** The file's page, table and picture counts. */
    pages: (count: number) => string;
    tables: (count: number) => string;
    pictures: (count: number) => string;
    ocrUsed: string;
    /** A calendar day, given as an ISO timestamp read in UTC. */
    day: (iso: string) => string | null;
    status: Record<MediaDocumentInfo['status'], string>;
    corrected: string;
    truncated: string;
    retry: string;
    extract: string;
    reextract: string;
    view: string;
    /** Why the text could not be read; `code` is one of `ATTACHMENT_TEXT_ERROR_CODES`. */
    textError: (code: string) => string;
    dialog: {
      discard: string;
      save: string;
      close: string;
      corrected: (day: string | null) => string;
      truncated: string;
      lastError: (reason: string) => string;
      failed: string;
    };
  };
  breadcrumb: { label: string; empty: string };
  tableOfContents: { label: string; empty: string };
  toggle: { collapse: string; expand: string };
  embed: { frameTitle: string };
}

/** `2026-04-26T11:56:10.000Z` as `26.04.2026`, read in UTC. */
function germanDay(iso: string): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${parsed.getUTCFullYear()}`;
}

/** The German source, and what a host that hands in nothing shows. */
export const GERMAN_EDITOR_WORDS: EditorWords = {
  media: {
    open: 'Öffnen',
    download: 'Herunterladen',
    pages: (count) => (count === 1 ? '1 Seite' : `${count} Seiten`),
    tables: (count) => (count === 1 ? '1 Tabelle' : `${count} Tabellen`),
    pictures: (count) => (count === 1 ? '1 Bild' : `${count} Bilder`),
    ocrUsed: 'per Texterkennung gelesen',
    day: germanDay,
    status: {
      not_applicable: 'Noch nicht ausgelesen',
      pending: 'Text wird ausgelesen …',
      ready: 'Text gelesen',
      failed: 'Kein Text lesbar',
    },
    corrected: 'Von Hand korrigiert',
    truncated: 'Gekürzt',
    retry: 'Erneut versuchen',
    extract: 'Text auslesen',
    reextract: 'Erneut auslesen',
    view: 'Ansehen',
    textError: () => 'Der Text der Datei konnte nicht gelesen werden',
    dialog: {
      discard: 'Korrektur verwerfen',
      save: 'Speichern',
      close: 'Schließen',
      corrected: (day) =>
        day === null ? 'Von Hand korrigiert.' : `Von Hand korrigiert am ${day}.`,
      truncated: 'Der ausgelesene Text wurde gekürzt und ist nicht vollständig.',
      lastError: (reason) => `Fehler bei der letzten Auslesung: ${reason}`,
      failed: 'Das hat nicht geklappt. Bitte erneut versuchen.',
    },
  },
  breadcrumb: {
    label: 'Navigationspfad',
    empty: 'Diese Seite hat keine übergeordneten Seiten.',
  },
  tableOfContents: {
    label: 'Inhaltsverzeichnis',
    empty: 'Noch keine Überschriften auf dieser Seite.',
  },
  toggle: { collapse: 'Abschnitt einklappen', expand: 'Abschnitt ausklappen' },
  embed: { frameTitle: 'Eingebetteter Inhalt' },
};
