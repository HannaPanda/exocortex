import { type Editor } from '@tiptap/core';

import { CALLOUT_VARIANTS, type CalloutVariant } from './callout';

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
] as const;

export type BlockIconName = (typeof BLOCK_ICON_NAMES)[number];

/** Menu sections, in the order they are shown. */
export const BLOCK_GROUPS = ['basic', 'lists', 'callout', 'media', 'advanced'] as const;

export type BlockGroup = (typeof BLOCK_GROUPS)[number];

/** German section headings for the menus. */
export const BLOCK_GROUP_LABELS: Readonly<Record<BlockGroup, string>> = {
  basic: 'Grundlagen',
  lists: 'Listen',
  callout: 'Hinweise',
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
  /** A page from this workspace, for a page link. */
  | 'page'
  /** A LaTeX expression. */
  | 'latex'
  /** An existing database from this workspace, for a database embed. */
  | 'database';

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
  /** Performs the insertion or the conversion. Returns whether it applied. */
  run: (editor: Editor, value?: string) => boolean;
  /** Whether the current selection already is this block. */
  isActive?: (editor: Editor) => boolean;
}

/** German labels for the callout variants, used by the catalog and the menus. */
export const CALLOUT_LABELS: Readonly<Record<CalloutVariant, string>> = {
  info: 'Hinweis',
  note: 'Notiz',
  success: 'Erfolg',
  warning: 'Warnung',
  danger: 'Gefahr',
};

const CALLOUT_ICONS: Readonly<Record<CalloutVariant, BlockIconName>> = {
  info: 'Info',
  note: 'Lightbulb',
  success: 'CircleCheck',
  warning: 'TriangleAlert',
  danger: 'OctagonAlert',
};

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

/** Blocks contributed by the `callout` unit. */
export const calloutBlocks: readonly BlockCatalogEntry[] = CALLOUT_VARIANTS.map((variant) => ({
  id: `callout-${variant}`,
  label: CALLOUT_LABELS[variant],
  description: `Hervorgehobener Kasten (${CALLOUT_LABELS[variant].toLowerCase()})`,
  keywords: ['hinweis', 'callout', 'kasten', 'box', 'admonition', variant],
  group: 'callout' as const,
  icon: CALLOUT_ICONS[variant],
  prompt: 'none' as const,
  turnInto: true,
  run: (editor: Editor) => editor.chain().focus().setCallout({ variant }).run(),
  isActive: (editor: Editor) => editor.isActive('callout', { variant }),
}));

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
