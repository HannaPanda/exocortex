import { type Editor } from '@tiptap/core';

/**
 * The block catalog: one description of every block a writer can insert or
 * convert into.
 *
 * It exists so the slash menu, the "in anderen Block umwandeln" menu and the
 * block action menu are never three lists that drift apart. Adding a block means
 * adding one catalog entry next to its extension, and it appears in all three.
 *
 * The catalog stays free of React and of icon components: `packages/editor` must
 * remain usable on the server (headless materialization), so an entry names its
 * icon and the web layer resolves the name to a component.
 */

/** Icon names, resolved to lucide components in `apps/web`. */
export const BLOCK_ICON_NAMES = [
  'Type',
  'Heading1',
  'Heading2',
  'Heading3',
  'List',
  'ListOrdered',
  'ListChecks',
  'ListTree',
  'Quote',
  'Code',
  'Minus',
  'Table',
  'Image',
  'Paperclip',
  'Video',
  'AudioLines',
  'FileText',
  'Bookmark',
  'Globe',
  'Info',
  'Lightbulb',
  'CircleCheck',
  'TriangleAlert',
  'OctagonAlert',
  'ChevronRight',
  'Columns2',
  'Sigma',
  'ListTodo',
  'Link2',
  'AtSign',
  'Smile',
  'LayoutGrid',
  'ListFilter',
  'Blocks',
] as const;

export type BlockIconName = (typeof BLOCK_ICON_NAMES)[number];

/** Menu sections, in the order they are shown. */
export const BLOCK_GROUPS = ['basic', 'lists', 'media', 'advanced'] as const;

export type BlockGroup = (typeof BLOCK_GROUPS)[number];

/** German section headings for the menus. */
export const BLOCK_GROUP_LABELS: Readonly<Record<BlockGroup, string>> = {
  basic: 'Grundlagen',
  lists: 'Listen',
  media: 'Medien',
  advanced: 'Erweitert',
};

/**
 * Extra input an entry needs before it can run.
 *
 * The catalog cannot open a dialog itself, so it declares *what* it needs and the
 * web layer collects it and passes it back into `run`.
 */
export type BlockPromptKind =
  | 'none'
  /** A URL, for example an image or a bookmark. */
  | 'url'
  /** A file upload, handled by the attachment endpoint. */
  | 'file'
  /**
   * The address of a file on the web, which the attachment endpoint fetches
   * and stores (issue #212). Answers like `file`, with this deployment's own
   * address of the stored copy, never the foreign one: the page's Content
   * Security Policy would block that.
   */
  | 'file-from-url'
  /** A page from this workspace, for a page link. */
  | 'page'
  /** A LaTeX expression. */
  | 'latex'
  /** An existing database from this workspace, for a database embed. */
  | 'database'
  /** An existing saved query from this workspace, for a query block (issue #74). */
  | 'saved-query';

export interface BlockCatalogEntry {
  /** Stable identifier; used by tests, the slash menu and the block menu. */
  id: string;
  /** Visible German label. */
  label: string;
  /** Visible German one-liner shown under the label. */
  description: string;
  /**
   * Additional search terms, lowercase. The label is always searched, so this is
   * for synonyms and for the English words a keyboard-first user will type.
   */
  keywords: readonly string[];
  group: BlockGroup;
  icon: BlockIconName;
  /** What `run` needs beyond the editor. */
  prompt: BlockPromptKind;
  /**
   * Whether an existing block may be converted into this one. Insert-only blocks
   * (a divider, a table) are excluded from the "turn into" menu.
   */
  turnInto: boolean;
  /**
   * The list node a list entry makes (`bulletList`, `orderedList`,
   * `taskList`). Turning a list item into a block reads it to tell a change of
   * list kind from a conversion that takes the item out of its list
   * (`turnBlockInto`, issue #284).
   */
  makesList?: string;
  /**
   * The node an insert-only entry puts on the page, where that decides whether
   * it is offered at all: a database is not offered inside a table cell
   * (`blockCatalogAllowedAt`, issue #312). Entries that may go anywhere a
   * block goes leave it out.
   */
  inserts?: string;
  /** Performs the insertion or the conversion. Returns whether it applied. */
  run: (editor: Editor, value?: string) => boolean;
  /** Whether the current selection already is this block. */
  isActive?: (editor: Editor) => boolean;
}

/** Blocks contributed by the `core-structure` unit. */
export const coreStructureBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'paragraph',
    label: 'Text',
    description: 'Ein normaler Absatz',
    keywords: ['absatz', 'text', 'paragraph', 'p'],
    group: 'basic',
    icon: 'Type',
    prompt: 'none',
    turnInto: true,
    run: (editor) => editor.chain().focus().setParagraph().run(),
    isActive: (editor) => editor.isActive('paragraph'),
  },
  ...([1, 2, 3] as const).map((level) => ({
    id: `heading-${level}`,
    label: `Überschrift ${level}`,
    description: `Abschnittstitel der Ebene ${level}`,
    keywords: ['überschrift', 'heading', 'titel', `h${level}`, '#'.repeat(level)],
    group: 'basic' as const,
    icon: `Heading${level}` as BlockIconName,
    prompt: 'none' as const,
    turnInto: true,
    run: (editor: Editor) => editor.chain().focus().setNode('heading', { level }).run(),
    isActive: (editor: Editor) => editor.isActive('heading', { level }),
  })),
  {
    id: 'blockquote',
    label: 'Zitat',
    description: 'Hervorgehobenes Zitat',
    keywords: ['zitat', 'quote', 'blockquote', '>'],
    group: 'basic',
    icon: 'Quote',
    prompt: 'none',
    turnInto: true,
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
    isActive: (editor) => editor.isActive('blockquote'),
  },
  {
    id: 'code-block',
    label: 'Codeblock',
    description: 'Code mit Syntaxhervorhebung',
    keywords: ['code', 'codeblock', 'quelltext', 'snippet', '```'],
    group: 'basic',
    icon: 'Code',
    prompt: 'none',
    turnInto: true,
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
    isActive: (editor) => editor.isActive('codeBlock'),
  },
  {
    id: 'horizontal-rule',
    label: 'Trennlinie',
    description: 'Waagerechte Linie zwischen Abschnitten',
    keywords: ['trennlinie', 'linie', 'divider', 'hr', '---'],
    group: 'basic',
    icon: 'Minus',
    prompt: 'none',
    turnInto: false,
    run: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
];

/** Blocks contributed by the `lists` unit. */
export const listBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'bullet-list',
    label: 'Aufzählung',
    description: 'Liste mit Punkten',
    keywords: ['liste', 'aufzählung', 'bullet', 'ul', '-'],
    group: 'lists',
    icon: 'List',
    prompt: 'none',
    turnInto: true,
    makesList: 'bulletList',
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
    isActive: (editor) => editor.isActive('bulletList'),
  },
  {
    id: 'ordered-list',
    label: 'Nummerierte Liste',
    description: 'Liste mit Zahlen',
    keywords: ['nummeriert', 'liste', 'ordered', 'ol', '1.'],
    group: 'lists',
    icon: 'ListOrdered',
    prompt: 'none',
    turnInto: true,
    makesList: 'orderedList',
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
    isActive: (editor) => editor.isActive('orderedList'),
  },
  {
    id: 'task-list',
    label: 'Aufgabenliste',
    description: 'Liste mit Kontrollkästchen',
    keywords: ['aufgabe', 'todo', 'task', 'checkbox', 'haken'],
    group: 'lists',
    icon: 'ListChecks',
    prompt: 'none',
    turnInto: true,
    makesList: 'taskList',
    run: (editor) => editor.chain().focus().toggleTaskList().run(),
    isActive: (editor) => editor.isActive('taskList'),
  },
];

/** Blocks contributed by the `media` unit (the image node). */
export const imageBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'image',
    label: 'Bild',
    description: 'Bild hochladen',
    keywords: ['bild', 'image', 'foto', 'grafik', 'screenshot', 'png', 'jpg'],
    group: 'media',
    icon: 'Image',
    prompt: 'file',
    turnInto: false,
    run: (editor, value) => {
      if (value === undefined || value.length === 0) return false;
      return editor.chain().focus().setImage({ src: value }).run();
    },
    isActive: (editor) => editor.isActive('image'),
  },
  {
    // The browser's half of `exo_attachment_upload_url` (issue #212): a
    // picture somebody found on the web becomes a file of this page, because
    // a foreign address never loads here.
    id: 'image-from-url',
    // Never shown: the browser reads `editor.blocks.image-from-url` from the
    // message catalogue, and nothing else builds the menu.
    label: 'Foto per URL',
    description: 'Foto von einer Adresse holen',
    keywords: ['bild', 'image', 'foto', 'url', 'link', 'adresse', 'internet', 'web', 'import'],
    group: 'media',
    icon: 'Image',
    prompt: 'file-from-url',
    turnInto: false,
    run: (editor, value) => {
      if (value === undefined || value.length === 0) return false;
      return editor.chain().focus().setImage({ src: value }).run();
    },
  },
];

/** Blocks contributed by the `tables` unit. */
export const tableBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'table',
    label: 'Tabelle',
    description: 'Tabelle mit Kopfzeile',
    keywords: ['tabelle', 'table', 'raster', 'grid'],
    group: 'advanced',
    icon: 'Table',
    prompt: 'none',
    turnInto: false,
    run: (editor) =>
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
];

/**
 * Blocks contributed by the `callout` unit: one entry (issue #306).
 *
 * There used to be one per variant, five entries for one box in five colours.
 * Now a callout starts with the light bulb and no heading, and its symbol,
 * heading and colour are chosen on the box itself.
 */
export const calloutBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'callout',
    label: 'Hinweis',
    description: 'Hervorgehobener Kasten mit Symbol, Überschrift und Farbe',
    // Every name the five old variants and their usual synonyms went by, so
    // the word somebody typed for the box they meant still finds it.
    keywords: [
      'hinweis',
      'callout',
      'kasten',
      'box',
      'admonition',
      'alert',
      'info',
      'notiz',
      'note',
      'tipp',
      'tip',
      'wichtig',
      'important',
      'warning',
      'caution',
      'gefahr',
      'danger',
      'erfolg',
      'success',
    ],
    group: 'basic',
    icon: 'Lightbulb',
    prompt: 'none',
    turnInto: true,
    run: (editor: Editor) => editor.chain().focus().setCallout().run(),
    isActive: (editor: Editor) => editor.isActive('callout'),
  },
];

/** Groups a flat catalog into the menu sections, dropping empty ones. */
export function groupBlockCatalog(
  entries: readonly BlockCatalogEntry[],
): { group: BlockGroup; label: string; entries: BlockCatalogEntry[] }[] {
  return BLOCK_GROUPS.map((group) => ({
    group,
    label: BLOCK_GROUP_LABELS[group],
    entries: entries.filter((entry) => entry.group === group),
  })).filter((section) => section.entries.length > 0);
}

/**
 * Filters the catalog by a query, matching the label and the keywords.
 *
 * Deliberately a prefix and substring match rather than a fuzzy score: the daily
 * user types two or three letters they already know, and a fuzzy matcher would
 * reorder the list under them while they type (PRODUCT.md, "Fast").
 */
export function filterBlockCatalog(
  entries: readonly BlockCatalogEntry[],
  query: string,
): BlockCatalogEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...entries];

  const scored = entries
    .map((entry) => {
      const label = entry.label.toLowerCase();
      if (label.startsWith(needle)) return { entry, score: 0 };
      if (entry.keywords.some((keyword) => keyword.startsWith(needle))) return { entry, score: 1 };
      if (label.includes(needle)) return { entry, score: 2 };
      if (entry.keywords.some((keyword) => keyword.includes(needle))) return { entry, score: 3 };
      return null;
    })
    .filter(
      (candidate): candidate is { entry: BlockCatalogEntry; score: number } => candidate !== null,
    );

  // Stable sort: equal scores keep the catalog order, so the list never jumps.
  return scored.sort((a, b) => a.score - b.score).map((candidate) => candidate.entry);
}
