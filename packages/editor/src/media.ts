import { mergeAttributes, Node } from '@tiptap/core';

import { type BlockCatalogEntry, type BlockIconName } from './block-catalog';
import { type MarkdownExtensionAdapter, type PlainTextAdapter } from './contract';

/**
 * File, video, audio and PDF blocks.
 *
 * All four are the same shape — a URL, a display name and a caption — so they are
 * generated from one description instead of four near-identical node modules. What
 * differs is the tag they render and how a reader is meant to consume them, which
 * is exactly what a block type is for.
 *
 * The URL always points at the attachment download endpoint of the API; the
 * editor never talks to object storage (see scripts/dependency-graph.mjs).
 */
interface MediaKind {
  /** ProseMirror node name. */
  name: 'fileAttachment' | 'video' | 'audio' | 'pdf';
  /** Container name in the Markdown syntax (`:::video …`). */
  container: string;
  label: string;
  description: string;
  keywords: readonly string[];
  icon: BlockIconName;
}

const MEDIA_KINDS: readonly MediaKind[] = [
  {
    name: 'fileAttachment',
    container: 'file',
    label: 'Datei',
    description: 'Datei zum Herunterladen',
    keywords: ['datei', 'file', 'anhang', 'attachment', 'download'],
    icon: 'Paperclip',
  },
  {
    name: 'video',
    container: 'video',
    label: 'Video',
    description: 'Video im Player abspielen',
    keywords: ['video', 'film', 'mp4', 'webm', 'abspielen'],
    icon: 'Video',
  },
  {
    name: 'audio',
    container: 'audio',
    label: 'Audio',
    description: 'Audiodatei abspielen',
    keywords: ['audio', 'ton', 'musik', 'mp3', 'sprachnotiz'],
    icon: 'AudioLines',
  },
  {
    name: 'pdf',
    container: 'pdf',
    label: 'PDF',
    description: 'PDF eingebettet anzeigen',
    keywords: ['pdf', 'dokument', 'vorschau'],
    icon: 'FileText',
  },
];

/**
 * What an extraction knows about a document, as the block needs it.
 *
 * Structurally identical to the relevant part of `PdfMetadata` in
 * `@exocortex/contracts`, but declared here rather than imported: this package
 * is a leaf and depends on no other Exocortex package (see
 * `scripts/dependency-graph.mjs`). The host passes its contract object straight
 * in; TypeScript accepts it because the shapes line up.
 */
export interface MediaDocumentMetadata {
  title: string | null;
  author: string | null;
  createdAt: string | null;
  pageCount: number | null;
  tableCount: number | null;
  pictureCount: number | null;
  ocrUsed: boolean | null;
}

export interface MediaDocumentInfo {
  status: 'not_applicable' | 'pending' | 'ready' | 'failed';
  metadata: MediaDocumentMetadata | null;
  error: string | null;
  /**
   * The stored file name, used when the block has none of its own.
   *
   * The slash menu inserts a media block with only a `src` (see `mediaBlocks`
   * in this file: the file prompt resolves to a URL and nothing else), so those
   * blocks would otherwise show the download URL where the file name belongs.
   * Documents written that way are already out there, so the label is repaired
   * from the resolved answer rather than only at insertion time.
   */
  filename: string | null;
}

/**
 * How a block learns what a file contains.
 *
 * The editor never talks to the API itself -- it does not know the route shape
 * and must not -- so the host injects this through
 * `buildEditorExtensions({ mediaInfo })`. Without it the blocks render exactly
 * as before, which is what keeps server-side rendering and the tests unchanged.
 */
export interface MediaInfoResolver {
  /**
   * Reads the current state for a media `src`. Must be free of side effects: it
   * runs on every render, so it may not start an extraction.
   *
   * Null when `src` is nothing the host can describe.
   */
  read(src: string): Promise<MediaDocumentInfo | null>;
  /** Asks for an extraction to (re-)run. Absent when the reader may not. */
  request?(src: string): Promise<MediaDocumentInfo | null>;
}

export interface MediaNodeOptions {
  mediaInfo: MediaInfoResolver | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    exocortexMedia: {
      /** Inserts a media block of `type` pointing at `src`. */
      insertMedia: (
        type: 'fileAttachment' | 'video' | 'audio' | 'pdf',
        attributes: { src: string; name?: string },
      ) => ReturnType;
    };
  }
}

function stringAttribute(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Builds one media node. */
function createMediaNode(kind: MediaKind) {
  return Node.create<MediaNodeOptions>({
    name: kind.name,
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,

    addOptions() {
      return { mediaInfo: null };
    },

    addAttributes() {
      return {
        src: {
          default: '',
          parseHTML: (element) => element.getAttribute('data-src') ?? '',
          renderHTML: (attributes) => ({ 'data-src': stringAttribute(attributes.src) }),
        },
        name: {
          default: '',
          parseHTML: (element) => element.getAttribute('data-name') ?? '',
          renderHTML: (attributes) => ({ 'data-name': stringAttribute(attributes.name) }),
        },
      };
    },

    parseHTML() {
      return [{ tag: `figure[data-media='${kind.name}']` }];
    },

    renderHTML({ HTMLAttributes, node }) {
      const src = stringAttribute(node.attrs.src);
      const name = stringAttribute(node.attrs.name);
      return [
        'figure',
        mergeAttributes(HTMLAttributes, {
          'data-media': kind.name,
          class: `exocortex-media exocortex-media-${kind.name}`,
        }),
        ...renderMediaBody(kind, src, name),
      ];
    },

    addNodeView() {
      const resolver: MediaInfoResolver | null = this.options.mediaInfo;

      return ({ node }) => {
        const dom = window.document.createElement('figure');
        dom.className = `exocortex-media exocortex-media-${kind.name}`;
        dom.dataset.media = kind.name;
        // The player and the download link are controls, not editable text.
        dom.contentEditable = 'false';

        const src = stringAttribute(node.attrs.src);
        const name = stringAttribute(node.attrs.name);
        const element = buildMediaElement(kind, src, name);
        dom.append(element);

        // A video does not have a text layer, and nothing is resolved without a
        // host resolver, so both cases skip straight past this.
        if (kind.name !== 'pdf' && kind.name !== 'fileAttachment') {
          return { dom, ignoreMutation: () => true };
        }
        const details = attachDocumentDetails(kind, element, src, name, resolver);

        return {
          dom,
          ignoreMutation: () => true,
          // A node view is rebuilt whenever its attributes change, so a
          // response still in flight belongs to a block that no longer exists.
          destroy: () => details?.cancel(),
        };
      };
    },
  });
}

/** Static markup for server-side rendering and HTML export. */
function renderMediaBody(
  kind: MediaKind,
  src: string,
  name: string,
): [string, Record<string, string>, ...string[]][] {
  const label = name.length > 0 ? name : src;
  switch (kind.name) {
    case 'video':
      return [['video', { src, controls: 'true', preload: 'metadata' }]];
    case 'audio':
      return [['audio', { src, controls: 'true', preload: 'metadata' }]];
    case 'pdf':
      return [['a', { href: src, rel: 'noopener noreferrer' }, label]];
    case 'fileAttachment':
      return [['a', { href: src, rel: 'noopener noreferrer', download: '' }, label]];
  }
}

/**
 * Viewer parameters that switch the browser's own PDF toolbar off.
 *
 * That toolbar promises two things Exocortex cannot keep. Its annotation tools
 * draw into the viewer only: the marks live in the tab, not in the document, and
 * are gone on reload. Its save button writes the original file to disk, which
 * reads as "discard my drawing" to anyone who just drew. Hiding the toolbar
 * removes the false promise; the two actions that do work sit in the header.
 *
 * Real annotations would mean storing them as document content and rendering the
 * pages ourselves — a feature, not a fix. See docs/deviations.md.
 */
const PDF_VIEWER_PARAMETERS = '#toolbar=0&navpanes=0';

/** Header link, used for both PDF actions. */
function buildPdfAction(src: string, text: string, download: boolean): HTMLAnchorElement {
  const anchor = window.document.createElement('a');
  anchor.href = src;
  anchor.rel = 'noopener noreferrer';
  anchor.textContent = text;
  if (download) anchor.download = '';
  else anchor.target = '_blank';
  return anchor;
}

/** Preview of a PDF plus the actions a reader actually has. */
function buildPdfElement(src: string, label: string): HTMLElement {
  const container = window.document.createElement('div');
  container.className = 'exocortex-pdf';

  const header = window.document.createElement('div');
  header.className = 'exocortex-pdf-header';
  const title = window.document.createElement('span');
  title.className = 'exocortex-pdf-name';
  title.textContent = label;
  header.append(
    title,
    buildPdfAction(src, 'Öffnen', false),
    buildPdfAction(src, 'Herunterladen', true),
  );

  // An `<object>` rather than an `<iframe>`: it degrades to its own children, so a
  // browser without a PDF viewer still shows the download link.
  const object = window.document.createElement('object');
  object.data = `${src}${PDF_VIEWER_PARAMETERS}`;
  object.type = 'application/pdf';
  object.append(buildPdfAction(src, label, true));

  container.append(header, object);
  return container;
}

/** `2026-04-26T11:56:10.000Z` as `26.04.2026`, without depending on a locale. */
function formatDay(iso: string): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${parsed.getUTCFullYear()}`;
}

/**
 * The document's facts as short German labels.
 *
 * Only what is actually known is listed. A null means no source could tell, not
 * zero, so "0 Tabellen" would be a claim nobody made -- and a row of "unbekannt"
 * would be noise in a header that has to stay one line.
 */
function describeDocument(metadata: MediaDocumentMetadata | null): string[] {
  if (metadata === null) return [];

  const chips: string[] = [];
  if (metadata.title !== null) chips.push(metadata.title);
  if (metadata.author !== null) chips.push(metadata.author);
  if (metadata.pageCount !== null) {
    chips.push(metadata.pageCount === 1 ? '1 Seite' : `${metadata.pageCount} Seiten`);
  }
  if (metadata.tableCount !== null && metadata.tableCount > 0) {
    chips.push(metadata.tableCount === 1 ? '1 Tabelle' : `${metadata.tableCount} Tabellen`);
  }
  if (metadata.pictureCount !== null && metadata.pictureCount > 0) {
    chips.push(metadata.pictureCount === 1 ? '1 Bild' : `${metadata.pictureCount} Bilder`);
  }
  if (metadata.createdAt !== null) {
    const day = formatDay(metadata.createdAt);
    if (day !== null) chips.push(day);
  }
  if (metadata.ocrUsed === true) chips.push('per Texterkennung gelesen');
  return chips;
}

const STATUS_NOTES: Record<MediaDocumentInfo['status'], string | null> = {
  not_applicable: null,
  pending: 'Text wird ausgelesen …',
  ready: null,
  failed: 'Kein Text lesbar',
};

/**
 * How long to wait before asking again while an extraction runs.
 *
 * Extraction is a background job of very uneven length: a text-layer PDF is
 * done in seconds, a scanned one takes about one and a half seconds per page.
 * The delays grow so that the common case updates quickly without the slow case
 * turning into a stream of requests, and the list ends, so a job that never
 * finishes cannot leave a tab polling forever.
 */
const POLL_DELAYS_MS = [2_000, 3_000, 5_000, 8_000, 12_000, 15_000, 15_000, 15_000, 15_000, 15_000];

function buildChip(label: string): HTMLElement {
  const chip = window.document.createElement('span');
  chip.className = 'exocortex-media-chip';
  chip.textContent = label;
  return chip;
}

/**
 * The line under a media block describing what was read out of the file.
 *
 * Returns null when there is nothing to resolve, so the caller has nothing to
 * clean up either.
 */
/** Replaces a placeholder label once the real file name is known. */
function applyLabel(kind: MediaKind, element: HTMLElement, label: string): void {
  if (kind.name !== 'pdf') {
    element.textContent = label;
    return;
  }
  const title = element.querySelector('.exocortex-pdf-name');
  if (title !== null) title.textContent = label;
  // The `<object>` fallback link carries the same label.
  const fallback = element.querySelector('object > a');
  if (fallback !== null) fallback.textContent = label;
}

function attachDocumentDetails(
  kind: MediaKind,
  element: HTMLElement,
  src: string,
  name: string,
  resolver: MediaInfoResolver | null,
): { cancel: () => void } | null {
  if (resolver === null || src.length === 0) return null;

  const bar = window.document.createElement('div');
  bar.className = 'exocortex-media-meta';
  bar.hidden = true;
  // Inside the PDF frame it belongs under the header; a file block is a single
  // link, so the line goes after it rather than into it.
  if (kind.name === 'pdf') element.querySelector('.exocortex-pdf-header')?.after(bar);
  else element.after(bar);

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let polls = 0;

  const render = (info: MediaDocumentInfo | null): void => {
    if (cancelled) return;
    bar.replaceChildren();
    if (info === null) {
      bar.hidden = true;
      return;
    }

    // A block inserted through the slash menu has no name of its own, so it is
    // showing its download URL until this arrives.
    if (name.length === 0 && info.filename !== null) applyLabel(kind, element, info.filename);

    // `not_applicable` is the ordinary answer for every non-PDF file, so the
    // line stays away rather than saying "no text".
    if (info.status === 'not_applicable') {
      bar.hidden = true;
      return;
    }

    for (const chip of describeDocument(info.metadata)) bar.append(buildChip(chip));

    const note = STATUS_NOTES[info.status];
    if (note !== null) {
      const noteChip = buildChip(note);
      noteChip.classList.add(`exocortex-media-chip-${info.status}`);
      // The reason a document could not be read is worth having, but not worth
      // a second line in a header.
      if (info.error !== null) noteChip.title = info.error;
      bar.append(noteChip);
    }

    if (info.status === 'failed' && resolver.request !== undefined) bar.append(buildRetry());
    bar.hidden = bar.childElementCount === 0;

    // Keep watching only while something is actually running.
    if (info.status === 'pending') schedulePoll();
  };

  const buildRetry = (): HTMLElement => {
    const button = window.document.createElement('button');
    button.type = 'button';
    button.className = 'exocortex-media-retry';
    button.textContent = 'Erneut versuchen';
    button.addEventListener('click', () => {
      polls = 0;
      button.disabled = true;
      void resolver.request?.(src).then(render, () => render(null));
    });
    return button;
  };

  const schedulePoll = (): void => {
    const delay = POLL_DELAYS_MS[polls];
    if (delay === undefined) return;
    polls += 1;
    timer = setTimeout(() => {
      void resolver.read(src).then(render, () => render(null));
    }, delay);
  };

  void resolver.read(src).then(render, () => render(null));

  return {
    cancel: () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}

/** Live DOM for the node view. */
function buildMediaElement(kind: MediaKind, src: string, name: string): HTMLElement {
  const label = name.length > 0 ? name : src;

  if (kind.name === 'video' || kind.name === 'audio') {
    const player = window.document.createElement(kind.name);
    player.src = src;
    player.controls = true;
    player.preload = 'metadata';
    return player;
  }

  if (kind.name === 'pdf') return buildPdfElement(src, label);

  const anchor = window.document.createElement('a');
  anchor.href = src;
  anchor.rel = 'noopener noreferrer';
  anchor.download = '';
  anchor.textContent = label;
  return anchor;
}

export const MEDIA_EXTENSIONS = MEDIA_KINDS.map(createMediaNode).map((node, index) =>
  index === 0
    ? node.extend({
        // The shared command lives on the first node so it is registered once.
        addCommands() {
          return {
            insertMedia:
              (type, attributes) =>
              ({ commands }) =>
                commands.insertContent({
                  type,
                  attrs: { src: attributes.src, name: attributes.name ?? '' },
                }),
          };
        },
      })
    : node,
);

/** Node names contributed here, for tests and for the addressable-block list. */
export const MEDIA_NODE_NAMES = MEDIA_KINDS.map((kind) => kind.name);

export const mediaMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: Object.fromEntries(
    MEDIA_KINDS.map((kind) => [
      kind.name,
      (node, context) => {
        const src = stringAttribute(node.attrs?.src);
        const name = stringAttribute(node.attrs?.name);
        const params = name.length > 0 ? `${src} ${name}` : src;
        return `:::${kind.container} ${params}${context.blockIdSuffix(node)}\n:::\n\n`;
      },
    ]),
  ),
  containers: Object.fromEntries(
    MEDIA_KINDS.map((kind) => [
      kind.container,
      (params, context) => {
        // The URL cannot contain a space, so the first one separates it from the
        // display name.
        const separator = params.indexOf(' ');
        const src = separator === -1 ? params : params.slice(0, separator);
        const name = separator === -1 ? '' : params.slice(separator + 1).trim();
        context.addNode(kind.name, { src, name });
        return 0;
      },
    ]),
  ),
};

/** Search projection: the file name is the searchable part, the URL is not. */
export const mediaPlainTextAdapter: PlainTextAdapter = {
  blocks: Object.fromEntries(
    MEDIA_KINDS.map((kind) => [
      kind.name,
      (node) => {
        const name = stringAttribute(node.attrs?.name);
        return name.length > 0 ? `${name}\n` : '';
      },
    ]),
  ),
};

export const mediaBlocks: readonly BlockCatalogEntry[] = MEDIA_KINDS.map((kind) => ({
  id: kind.container,
  label: kind.label,
  description: kind.description,
  keywords: kind.keywords,
  group: 'media' as const,
  icon: kind.icon,
  prompt: 'file' as const,
  turnInto: false,
  run: (editor, value) => {
    if (value === undefined || value.length === 0) return false;
    return editor.chain().focus().insertMedia(kind.name, { src: value }).run();
  },
  isActive: (editor) => editor.isActive(kind.name),
}));
