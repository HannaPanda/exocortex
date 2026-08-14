import { mergeAttributes, Node } from '@tiptap/core';

import { type BlockCatalogEntry } from './block-catalog';
import { type MarkdownExtensionAdapter, type PlainTextAdapter } from './contract';

/**
 * Hosts an `embed` block may load an iframe from.
 *
 * An allow list, not a filter: an arbitrary iframe is a script-execution and
 * clickjacking surface inside the document, and a document is shared content.
 * A URL that is not on this list becomes a bookmark instead of an embed, which
 * loses nothing a reader needs.
 *
 * Extending it is a security decision. Only add a host whose embed endpoint is
 * meant to be framed by third parties.
 */
export const EMBED_ALLOWED_HOSTS = [
  'www.youtube.com',
  'youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
  'player.vimeo.com',
  'vimeo.com',
  'codesandbox.io',
  'codepen.io',
  'www.figma.com',
  'figma.com',
  'excalidraw.com',
  'miro.com',
  'docs.google.com',
  'open.spotify.com',
  'soundcloud.com',
] as const;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    exocortexEmbed: {
      /** Inserts an embed, or a bookmark when the host is not allowed. */
      insertEmbedOrBookmark: (url: string) => ReturnType;
      /** Inserts a link preview card. */
      insertBookmark: (url: string) => ReturnType;
    };
  }
}

/** `true` when the URL may be framed. Rejects anything that is not http(s). */
export function isEmbeddableUrl(url: string): boolean {
  const parsed = safeUrl(url);
  if (parsed === null) return false;
  if (parsed.protocol !== 'https:') return false;
  return (EMBED_ALLOWED_HOSTS as readonly string[]).includes(parsed.hostname);
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Normalizes a page URL into its embeddable form.
 *
 * A user pastes the address from the browser bar (`youtube.com/watch?v=…`), which
 * is a page, not an embed endpoint. Framing the page fails silently, so the two
 * services where that difference matters most are translated here.
 */
export function toEmbedUrl(url: string): string {
  const parsed = safeUrl(url);
  if (parsed === null) return url;

  if (parsed.hostname === 'youtu.be') {
    return `https://www.youtube-nocookie.com/embed/${parsed.pathname.replace(/^\//, '')}`;
  }
  if (parsed.hostname.endsWith('youtube.com') && parsed.pathname === '/watch') {
    const id = parsed.searchParams.get('v');
    if (id !== null) return `https://www.youtube-nocookie.com/embed/${id}`;
  }
  if (parsed.hostname === 'vimeo.com') {
    const id = /^\/(\d+)/.exec(parsed.pathname)?.[1];
    if (id !== undefined) return `https://player.vimeo.com/video/${id}`;
  }
  return url;
}

function stringAttribute(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Embedded third-party content.
 *
 * `sandbox` is set without `allow-same-origin`, so framed content cannot reach
 * this origin's cookies or storage even if the host is later compromised.
 */
export const Embed = Node.create({
  name: 'embed',
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
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-embed]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const src = stringAttribute(node.attrs.src);
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-embed': '', class: 'exocortex-embed' }),
      isEmbeddableUrl(src)
        ? [
            'iframe',
            {
              src,
              loading: 'lazy',
              referrerpolicy: 'no-referrer',
              sandbox: 'allow-scripts allow-popups allow-presentation',
              allowfullscreen: 'true',
              title: 'Eingebetteter Inhalt',
            },
          ]
        : ['a', { href: src, rel: 'noopener noreferrer' }, src],
    ];
  },

  addCommands() {
    return {
      insertEmbedOrBookmark:
        (url: string) =>
        ({ commands }) => {
          const embedUrl = toEmbedUrl(url);
          return isEmbeddableUrl(embedUrl)
            ? commands.insertContent({ type: this.name, attrs: { src: embedUrl } })
            : commands.insertContent({ type: 'bookmark', attrs: { url } });
        },
    };
  },
});

/**
 * Link preview card (Notion's "Lesezeichen").
 *
 * Title, description and favicon are optional and are filled in by the worker
 * after the block is created: fetching metadata is a network call, and the editor
 * never makes one. Until then the card shows the URL, which is already useful.
 */
export const Bookmark = Node.create({
  name: 'bookmark',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      url: {
        default: '',
        parseHTML: (element) => element.getAttribute('href') ?? '',
        renderHTML: (attributes) => ({ href: stringAttribute(attributes.url) }),
      },
      title: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-title') ?? '',
        renderHTML: (attributes) => ({ 'data-title': stringAttribute(attributes.title) }),
      },
      description: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-description') ?? '',
        renderHTML: (attributes) => ({
          'data-description': stringAttribute(attributes.description),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-bookmark]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const url = stringAttribute(node.attrs.url);
    const title = stringAttribute(node.attrs.title);
    const description = stringAttribute(node.attrs.description);
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-bookmark': '',
        class: 'exocortex-bookmark',
        rel: 'noopener noreferrer',
        target: '_blank',
      }),
      ['span', { class: 'exocortex-bookmark-title' }, title.length > 0 ? title : url],
      ['span', { class: 'exocortex-bookmark-description' }, description],
      ['span', { class: 'exocortex-bookmark-url' }, hostOf(url)],
    ];
  },

  addCommands() {
    return {
      insertBookmark:
        (url: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { url } }),
    };
  },
});

/** Host of a URL, or the raw value when it does not parse. */
export function hostOf(url: string): string {
  return safeUrl(url)?.hostname ?? url;
}

export const EMBED_EXTENSIONS = [Embed, Bookmark];

export const embedMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    embed: (node, context) =>
      `:::embed ${stringAttribute(node.attrs?.src)}${context.blockIdSuffix(node)}\n:::\n\n`,
    bookmark: (node, context) => {
      const url = stringAttribute(node.attrs?.url);
      const title = stringAttribute(node.attrs?.title);
      const params = title.length > 0 ? `${url} ${title}` : url;
      return `:::bookmark ${params}${context.blockIdSuffix(node)}\n:::\n\n`;
    },
  },
  containers: {
    embed: (params, context) => {
      context.addNode('embed', { src: params.trim() });
      return 0;
    },
    bookmark: (params, context) => {
      const separator = params.indexOf(' ');
      const url = separator === -1 ? params : params.slice(0, separator);
      const title = separator === -1 ? '' : params.slice(separator + 1).trim();
      context.addNode('bookmark', { url, title, description: '' });
      return 0;
    },
  },
};

export const embedPlainTextAdapter: PlainTextAdapter = {
  blocks: {
    // The URL is not text a reader searches for; a fetched title is.
    embed: () => '',
    bookmark: (node) => {
      const title = stringAttribute(node.attrs?.title);
      const description = stringAttribute(node.attrs?.description);
      return [title, description]
        .filter((part) => part.length > 0)
        .join(' ')
        .concat('\n');
    },
  },
};

export const embedBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'embed',
    label: 'Einbettung',
    description: 'Externen Inhalt einbetten (YouTube, Figma, …)',
    keywords: ['einbetten', 'embed', 'iframe', 'youtube', 'vimeo', 'figma', 'video'],
    group: 'media',
    icon: 'Globe',
    prompt: 'url',
    turnInto: false,
    run: (editor, value) => {
      if (value === undefined || value.length === 0) return false;
      return editor.chain().focus().insertEmbedOrBookmark(value).run();
    },
    isActive: (editor) => editor.isActive('embed'),
  },
  {
    id: 'bookmark',
    label: 'Lesezeichen',
    description: 'Vorschaukarte für einen Link',
    keywords: ['lesezeichen', 'bookmark', 'link', 'vorschau', 'karte'],
    group: 'media',
    icon: 'Bookmark',
    prompt: 'url',
    turnInto: false,
    run: (editor, value) => {
      if (value === undefined || value.length === 0) return false;
      return editor.chain().focus().insertBookmark(value).run();
    },
    isActive: (editor) => editor.isActive('bookmark'),
  },
];
