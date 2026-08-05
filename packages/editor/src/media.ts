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
  return Node.create({
    name: kind.name,
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,

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
      return ({ node }) => {
        const dom = window.document.createElement('figure');
        dom.className = `exocortex-media exocortex-media-${kind.name}`;
        dom.dataset.media = kind.name;
        // The player and the download link are controls, not editable text.
        dom.contentEditable = 'false';

        const src = stringAttribute(node.attrs.src);
        const name = stringAttribute(node.attrs.name);
        dom.append(buildMediaElement(kind, src, name));
        return { dom, ignoreMutation: () => true };
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
