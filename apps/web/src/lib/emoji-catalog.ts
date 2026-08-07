/**
 * The emoji Exocortex offers.
 *
 * A curated set rather than the full Unicode table: a 1,800-entry dataset in a
 * product whose personality is speed is a bad trade (PRODUCT.md). Keywords are
 * German because the search field is.
 *
 * Shared by the editor's emoji menu, which inserts the character as text, and by
 * the page icon picker, which stores it in `Document.icon`.
 */
export interface EmojiGroup {
  label: string;
  emojis: readonly { char: string; keywords: readonly string[] }[];
}

export const EMOJI_GROUPS: readonly EmojiGroup[] = [
  {
    label: 'Häufig',
    emojis: [
      { char: '✅', keywords: ['haken', 'fertig', 'check', 'ok'] },
      { char: '❌', keywords: ['kreuz', 'fehler', 'nein', 'x'] },
      { char: '⚠️', keywords: ['warnung', 'achtung', 'warning'] },
      { char: '💡', keywords: ['idee', 'glühbirne', 'tipp'] },
      { char: '📌', keywords: ['pin', 'wichtig', 'merken'] },
      { char: '🔥', keywords: ['feuer', 'dringend', 'hot'] },
      { char: '🚀', keywords: ['rakete', 'start', 'launch', 'deploy'] },
      { char: '🐛', keywords: ['bug', 'fehler', 'käfer'] },
      { char: '🧠', keywords: ['gehirn', 'brain', 'denken'] },
      { char: '⏱️', keywords: ['zeit', 'timer', 'stoppuhr'] },
    ],
  },
  {
    label: 'Arbeit',
    emojis: [
      { char: '📝', keywords: ['notiz', 'schreiben', 'notes'] },
      { char: '📄', keywords: ['dokument', 'seite', 'datei'] },
      { char: '📁', keywords: ['ordner', 'projekt', 'folder'] },
      { char: '📊', keywords: ['diagramm', 'daten', 'chart'] },
      { char: '📅', keywords: ['kalender', 'termin', 'datum'] },
      { char: '🔗', keywords: ['link', 'verweis', 'kette'] },
      { char: '🔍', keywords: ['suche', 'lupe', 'finden'] },
      { char: '🛠️', keywords: ['werkzeug', 'tools', 'wartung'] },
      { char: '⚙️', keywords: ['einstellung', 'zahnrad', 'config'] },
      { char: '🔒', keywords: ['schloss', 'sicherheit', 'privat'] },
    ],
  },
  {
    label: 'Menschen',
    emojis: [
      { char: '👋', keywords: ['hallo', 'winken', 'hi'] },
      { char: '👍', keywords: ['daumen', 'gut', 'ok', 'plus'] },
      { char: '👎', keywords: ['daumen runter', 'schlecht'] },
      { char: '🙏', keywords: ['danke', 'bitte', 'hände'] },
      { char: '🎉', keywords: ['feier', 'party', 'erfolg'] },
      { char: '😀', keywords: ['lachen', 'freude', 'smile'] },
      { char: '🤔', keywords: ['nachdenken', 'hmm', 'frage'] },
      { char: '😅', keywords: ['schwitzen', 'knapp', 'ups'] },
      { char: '❤️', keywords: ['herz', 'liebe', 'love'] },
      { char: '☕', keywords: ['kaffee', 'pause', 'coffee'] },
    ],
  },
];

/** Groups whose emoji match the query, with the non-matching entries removed. */
export function filterEmojiGroups(query: string): readonly EmojiGroup[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return EMOJI_GROUPS;
  return EMOJI_GROUPS.map((group) => ({
    label: group.label,
    emojis: group.emojis.filter((emoji) =>
      emoji.keywords.some((keyword) => keyword.includes(needle)),
    ),
  })).filter((group) => group.emojis.length > 0);
}
