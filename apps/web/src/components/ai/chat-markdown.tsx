'use client';

import { CheckIcon, CopyIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  highlightCode,
  type HighlightNode,
  type OutlineEntry,
  parseMarkdown,
  type ProseMirrorDocument,
  type ProseMirrorNode,
  pruneForChat,
  pruneForReading,
  readOutlineFromJson,
  WIKI_LINK_SCHEME,
} from '@exocortex/editor';
import {
  Button,
  cn,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import { splitSettledMarkdown, stabilizeStreamingTail } from './streaming-markdown';

/**
 * How often a streaming answer is reparsed while it is still growing (issue
 * #21). Frequent enough that formatting appears almost immediately, infrequent
 * enough that a long answer is not reparsed on every streamed token.
 */
const PARSE_THROTTLE_MS = 100;

/** How long the copy button stays in its confirmed state. Matches `CodeBlockToolbar`. */
const COPIED_FEEDBACK_MS = 1_500;

/**
 * Parses `markdown` through the editor's own Markdown importer and prunes the
 * result down to the small node/mark vocabulary the chat renders (see
 * `pruneForChat`). The model's text is never trustworthy, so this also never
 * throws: an importer surprise mid-stream falls back to one plain paragraph
 * instead of taking the whole bubble down.
 */
function parseChatMarkdown(markdown: string): ProseMirrorDocument {
  try {
    return pruneForChat(parseMarkdown(markdown, { assignBlockIds: false }).document);
  } catch {
    return {
      type: 'doc',
      content:
        markdown.length > 0
          ? [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }]
          : [],
    };
  }
}

/** Parsed settled pieces of one streaming answer, by their source text. */
type SettledCache = Map<string, readonly ProseMirrorNode[]>;

/**
 * The top-level blocks of an answer that is still arriving (issue #242).
 *
 * Every block that is over (see `splitSettledMarkdown`) is parsed once and
 * then handed back as the very same object, which is what lets `ChatBlock`
 * skip it on every later render; only the tail is parsed again, after
 * `stabilizeStreamingTail` has held back the syntax that has not decided yet
 * what it is. The cache is rebuilt from the pieces still in use, so it never
 * holds more than the answer on screen.
 */
function parseStreamingBlocks(content: string, cache: SettledCache): readonly ProseMirrorNode[] {
  const { settled, tail } = splitSettledMarkdown(content);
  const next: SettledCache = new Map();
  const blocks: ProseMirrorNode[] = [];
  for (const piece of settled) {
    const parsed = cache.get(piece) ?? next.get(piece) ?? parseChatMarkdown(piece).content ?? [];
    next.set(piece, parsed);
    blocks.push(...parsed);
  }
  cache.clear();
  for (const [piece, parsed] of next) cache.set(piece, parsed);
  blocks.push(...(parseChatMarkdown(stabilizeStreamingTail(tail)).content ?? []));
  return blocks;
}

function parseBlocks(
  content: string,
  streaming: boolean,
  cache: SettledCache,
): readonly ProseMirrorNode[] {
  return streaming
    ? parseStreamingBlocks(content, cache)
    : (parseChatMarkdown(content).content ?? []);
}

/**
 * Parses `content` into the chat's ProseMirror subset, throttled to roughly
 * once every {@link PARSE_THROTTLE_MS} while `streaming` is true and memoized
 * against the last parsed string. Always parses immediately (and whole) once
 * `streaming` turns `false`, so the final render reflects the complete answer.
 */
function useChatMarkdownBlocks(content: string, streaming: boolean): readonly ProseMirrorNode[] {
  // The lazy initializer is a pure function of `content`; everything that
  // follows only ever mutates refs from inside an effect or a callback, never
  // synchronously during render (React's rules of components and hooks).
  const [blocks, setBlocks] = React.useState<readonly ProseMirrorNode[]>(() =>
    parseBlocks(content, streaming, new Map()),
  );

  const contentRef = React.useRef(content);
  const streamingRef = React.useRef(streaming);
  const settledRef = React.useRef<SettledCache>(new Map());
  const cacheRef = React.useRef<{ content: string; streaming: boolean }>({ content, streaming });
  const timerRef = React.useRef<number | null>(null);
  // `null` until the first parse; an unset "last parsed at" must not throttle
  // that first parse, which is why the effect below treats it as "long ago".
  const lastParseAtRef = React.useRef<number | null>(null);

  const parseNow = React.useCallback(() => {
    const latest = contentRef.current;
    const live = streamingRef.current;
    if (cacheRef.current.content === latest && cacheRef.current.streaming === live) return;
    const parsed = parseBlocks(latest, live, settledRef.current);
    cacheRef.current = { content: latest, streaming: live };
    lastParseAtRef.current = Date.now();
    setBlocks(parsed);
  }, []);

  React.useEffect(() => {
    contentRef.current = content;
    streamingRef.current = streaming;
    if (cacheRef.current.content === content && cacheRef.current.streaming === streaming) return;

    if (!streaming) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      parseNow();
      return;
    }

    // A timer is already pending; it reads `contentRef` when it fires, so it
    // will pick up this update without a second one being scheduled.
    if (timerRef.current !== null) return;

    const elapsed =
      lastParseAtRef.current === null
        ? Number.POSITIVE_INFINITY
        : Date.now() - lastParseAtRef.current;
    if (elapsed >= PARSE_THROTTLE_MS) {
      parseNow();
    } else {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        parseNow();
      }, PARSE_THROTTLE_MS - elapsed);
    }
  }, [content, streaming, parseNow]);

  React.useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return blocks;
}

function headingTag(level: number): 'h4' | 'h5' | 'h6' {
  if (level <= 1) return 'h4';
  if (level === 2) return 'h5';
  return 'h6';
}

function headingClassName(level: number): string {
  return level <= 2
    ? 'mt-3 mb-1 text-body font-semibold first:mt-0'
    : 'mt-2 mb-1 text-ui font-semibold first:mt-0';
}

function renderInlineChildren(
  nodes: readonly ProseMirrorNode[] | undefined,
  keyPrefix: string,
): React.ReactNode {
  return (nodes ?? []).map((node, index) => renderInlineNode(node, `${keyPrefix}-${index}`));
}

function renderInlineNode(node: ProseMirrorNode, key: string): React.ReactNode {
  if (node.type === 'hardBreak') return <br key={key} />;
  if (node.type !== 'text') return null;
  return renderText(node, key);
}

/**
 * Renders one text run with its marks. `pruneForChat` already limited the
 * marks to `bold` / `italic` / `code` / `link` and sanitized every `href`, so
 * this only has to decide how a wiki reference (`wiki:`-scheme link) looks:
 * plain, inert text, never a clickable anchor. Making it navigable is #22.
 */
function renderText(node: ProseMirrorNode, key: string): React.ReactNode {
  const text = node.text ?? '';
  if (text.length === 0) return null;
  const marks = node.marks ?? [];

  let content: React.ReactNode = text;
  for (const mark of marks) {
    if (mark.type === 'bold') content = <strong className="font-semibold">{content}</strong>;
    else if (mark.type === 'italic') content = <em className="italic">{content}</em>;
    else if (mark.type === 'code') {
      content = (
        <code className="rounded-sm bg-card px-1 py-0.5 font-mono text-[0.85em]">{content}</code>
      );
    }
  }

  const link = marks.find((mark) => mark.type === 'link');
  if (link !== undefined) {
    const href = typeof link.attrs?.href === 'string' ? link.attrs.href : '';
    if (href.startsWith(WIKI_LINK_SCHEME)) {
      return <WikiReference key={key}>{content}</WikiReference>;
    }
    return (
      <a
        key={key}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary-text underline underline-offset-2"
      >
        {content}
      </a>
    );
  }

  return <React.Fragment key={key}>{content}</React.Fragment>;
}

/** A table header/cell always wraps a single paragraph (see `parse.ts`); this
 *  renders that paragraph's inline content directly instead of nesting a `<p>`
 *  inside the `<th>`/`<td>`. */
function renderTableCellContent(node: ProseMirrorNode, keyPrefix: string): React.ReactNode {
  const paragraph = node.content?.[0];
  if (paragraph?.type === 'paragraph') return renderInlineChildren(paragraph.content, keyPrefix);
  return renderBlockChildren(node.content, keyPrefix);
}

function renderHighlightNodes(nodes: readonly HighlightNode[], keyPrefix: string): React.ReactNode {
  return nodes.map((node, index) => renderHighlightNode(node, `${keyPrefix}-${index}`));
}

function renderHighlightNode(node: HighlightNode, key: string): React.ReactNode {
  if (node.type === 'text') return <React.Fragment key={key}>{node.value ?? ''}</React.Fragment>;
  return (
    <span key={key} className={node.className?.join(' ')}>
      {renderHighlightNodes(node.children ?? [], key)}
    </span>
  );
}

/**
 * A fenced code block, highlighted with the same grammar registry as the
 * editor's code block (`highlightCode`, `packages/editor/src/code-block.ts`).
 *
 * The `exocortex-editor` class only wraps the highlighted spans, not the
 * `<pre>`/`<code>` themselves: that scope is what the shared `.hljs-*` colour
 * rules in `globals.css` key off, and keeping it inside the `<code>` (rather
 * than wrapping it) means this never picks up that stylesheet's *other*
 * `.exocortex-editor pre` / `.exocortex-editor code` background rules, which
 * are sized for the full editor, not a chat bubble.
 *
 * The block sits on `sunken` like every other piece of code (the
 * Code-Is-A-Well Rule in DESIGN.md): the syntax colours are measured against
 * that surface, and on a raised `card` the comment colour would fall under
 * 4.5:1 (issue #317).
 */
function ChatCodeBlock({ node, keyPrefix }: { node: ProseMirrorNode; keyPrefix: string }) {
  const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
  const text = React.useMemo(
    () => (node.content ?? []).map((child) => child.text ?? '').join(''),
    [node.content],
  );
  const highlighted = React.useMemo(() => highlightCode(text, language), [text, language]);

  return (
    <pre
      translate="no"
      // A long line scrolls the block sideways; the keyboard reaches it too.
      tabIndex={0}
      className="mb-1.5 overflow-x-auto rounded-md border border-border bg-sunken p-3 font-mono text-xs last:mb-0"
    >
      <code>
        <span className="exocortex-editor">{renderHighlightNodes(highlighted, keyPrefix)}</span>
      </code>
    </pre>
  );
}

function renderBlockChildren(
  nodes: readonly ProseMirrorNode[] | undefined,
  keyPrefix: string,
): React.ReactNode {
  return (nodes ?? []).map((node, index) => renderBlock(node, `${keyPrefix}-${index}`));
}

function renderBlock(node: ProseMirrorNode, key: string): React.ReactNode {
  switch (node.type) {
    case 'paragraph':
      return (
        <p key={key} className="mb-1.5 whitespace-pre-wrap break-words last:mb-0">
          {renderInlineChildren(node.content, key)}
        </p>
      );

    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
      const Tag = headingTag(level);
      // Set only by `withReadingAnchors`; the parser never writes this attribute,
      // so a chat answer cannot put an id of its choosing into the page.
      const anchor =
        typeof node.attrs?.[READING_ANCHOR] === 'string' ? node.attrs[READING_ANCHOR] : undefined;
      return (
        <Tag
          key={key}
          id={anchor}
          className={cn(headingClassName(level), anchor !== undefined && 'scroll-mt-4')}
        >
          {renderInlineChildren(node.content, key)}
        </Tag>
      );
    }

    case 'blockquote':
      return (
        <blockquote
          key={key}
          className="mb-1.5 border-l-2 border-border-strong pl-3 text-muted-foreground last:mb-0"
        >
          {renderBlockChildren(node.content, key)}
        </blockquote>
      );

    // `exocortex-list` carries the markers by depth (issue #250, `globals.css`):
    // a disc, a circle, a square; 1., a., i. -- the same table as the editor's.
    case 'bulletList':
      return (
        <ul key={key} className="exocortex-list mb-1.5 space-y-0.5 last:mb-0">
          {renderBlockChildren(node.content, key)}
        </ul>
      );

    case 'orderedList': {
      const start = typeof node.attrs?.start === 'number' ? node.attrs.start : 1;
      return (
        <ol key={key} start={start} className="exocortex-list mb-1.5 space-y-0.5 last:mb-0">
          {renderBlockChildren(node.content, key)}
        </ol>
      );
    }

    case 'listItem':
      return <li key={key}>{renderBlockChildren(node.content, key)}</li>;

    case 'codeBlock':
      return <ChatCodeBlock key={key} node={node} keyPrefix={key} />;

    case 'table':
      return (
        <Table
          key={key}
          containerClassName="mb-1.5 rounded-md border border-border last:mb-0"
          className="text-xs"
        >
          <TableBody>{renderBlockChildren(node.content, key)}</TableBody>
        </Table>
      );

    case 'tableRow':
      return <TableRow key={key}>{renderBlockChildren(node.content, key)}</TableRow>;

    // The primitive keeps a cell on one line, which suits a database grid; in
    // a chat answer a sentence per cell would make the table as wide as its
    // longest sentence, so the cells wrap and only an unbreakable word scrolls.
    case 'tableHeader':
      return (
        <TableHead key={key} className="h-auto py-1.5 align-top whitespace-normal">
          {renderTableCellContent(node, key)}
        </TableHead>
      );

    case 'tableCell':
      return (
        <TableCell key={key} className="align-top whitespace-normal">
          {renderTableCellContent(node, key)}
        </TableCell>
      );

    default:
      // The blocks only `pruneForReading` keeps, and then nothing:
      // `pruneForChat` already removed everything else, and this guards
      // against a future node type slipping through.
      return renderReadingBlock(node, key);
  }
}

/**
 * The blocks a page has and a chat bubble does not (issue #83, ADR-044).
 *
 * Only ever reached through `ReadingMarkdown`: `pruneForChat` drops them, so a
 * model's answer can never put an image on screen, which is what keeps a reply
 * from making the reader's browser fetch an address the model chose.
 */
function renderReadingBlock(node: ProseMirrorNode, key: string): React.ReactNode {
  if (node.type === 'horizontalRule') return <hr key={key} className="my-6 border-border" />;
  if (node.type === 'tableOfContents') return <ReadingTableOfContents key={key} />;
  if (node.type !== 'image') return null;

  const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
  const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
  if (src.length === 0) return null;
  return <ZoomableImage key={key} src={src} alt={alt} />;
}

/** The heading attribute that carries a reading anchor; see `withReadingAnchors`. */
const READING_ANCHOR = 'readingAnchor';

/** The outline of the page being read, for its table of contents (issue #228). */
const ReadingOutlineContext = React.createContext<readonly OutlineEntry[]>([]);

/**
 * Gives every heading of a page being read an anchor its table of contents can
 * point at (issue #228).
 *
 * The Markdown behind a public link carries no block ids, so the anchor is the
 * heading's position on the page. That is enough here: it is computed from the
 * same document the list is drawn from, in the same render. The anchor goes in
 * as the heading's `blockId` too, which is what the shared outline reader
 * links by.
 */
function withReadingAnchors(document: ProseMirrorDocument): ProseMirrorDocument {
  let count = 0;
  const walk = (nodes: readonly ProseMirrorNode[] | undefined): ProseMirrorNode[] | undefined =>
    nodes?.map((node) => {
      if (node.type === 'heading') {
        count += 1;
        const anchor = `abschnitt-${String(count)}`;
        return { ...node, attrs: { ...node.attrs, blockId: anchor, [READING_ANCHOR]: anchor } };
      }
      return node.content === undefined ? node : { ...node, content: walk(node.content) };
    });
  return { ...document, content: walk(document.content) };
}

/**
 * The table of contents of a page being read, drawn from its headings the way
 * the editor's block draws it, with the same classes (`globals.css`).
 */
function ReadingTableOfContents() {
  const t = useTranslations('editor.nodeViews.tableOfContents');
  const entries = React.useContext(ReadingOutlineContext);
  return (
    <nav aria-label={t('label')} data-toc="" className="exocortex-toc mb-3">
      {entries.length === 0 ? (
        <p className="text-muted-foreground">{t('empty')}</p>
      ) : (
        <ol>
          {entries.map((entry, index) => (
            <li
              key={`${entry.blockId ?? ''}-${String(index)}`}
              data-depth={Math.min(entry.depth, 3)}
            >
              {entry.blockId === null ? (
                entry.text
              ) : (
                <a
                  href={`#${entry.blockId}`}
                  className="text-primary-text underline-offset-2 hover:underline"
                >
                  {entry.text}
                </a>
              )}
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}

/**
 * An image a reader can open larger (issue #134). The button is what makes it
 * reachable by keyboard; the click itself is handled by `ImageLightboxArea`
 * around the page, which is why there is no handler here.
 */
function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const t = useTranslations('ui.imageLightbox');
  return (
    <button
      type="button"
      data-zoomable-trigger=""
      aria-label={alt.trim().length > 0 ? t('open', { alt }) : t('openUntitled')}
      className="mb-3 block max-w-full cursor-zoom-in rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {/* oxlint-disable-next-line nextjs/no-img-element --
          the address comes out of a page's content at runtime, so no loader
          configuration could cover it. */}
      <img src={src} alt={alt} data-zoomable="" className="max-w-full rounded-md" />
    </button>
  );
}

export interface ChatMarkdownProps {
  content: string;
  /** While `true`, parsing is throttled (see `useChatMarkdownDocument`). */
  streaming?: boolean;
  className?: string;
}

/**
 * Renders `content` as the chat's limited Markdown subset (issue #21):
 * paragraphs, bold/italic/inline code, code blocks, lists, small headings,
 * links, quotes and tables. Never dangerouslySetInnerHTML -- every node is
 * built as a React element from the pruned ProseMirror JSON, so there is no
 * path from model text to raw HTML.
 */
export function ChatMarkdown({ content, streaming = false, className }: ChatMarkdownProps) {
  const blocks = useChatMarkdownBlocks(content, streaming);
  return (
    <div className={className}>
      {blocks.map((node, index) => {
        const key = `block-${String(index)}`;
        return <ChatBlock key={key} node={node} blockKey={key} />;
      })}
    </div>
  );
}

/**
 * One top-level block of an answer. Memoized on the node's identity: a block
 * that is over keeps its object while the answer streams on (see
 * `parseStreamingBlocks`), so it is not rendered again for every fragment
 * that arrives below it.
 */
const ChatBlock = React.memo(function ChatBlock({
  node,
  blockKey,
}: {
  node: ProseMirrorNode;
  blockKey: string;
}) {
  return renderBlock(node, blockKey);
});

/**
 * The same renderer for a page somebody is reading rather than a chat bubble
 * (issue #83, ADR-044): images and horizontal rules survive.
 *
 * It shares this file rather than copying three hundred lines of node
 * rendering. The difference between the two is one pruner, and stating it in
 * one place is what keeps a shared page and a chat answer from slowly
 * rendering the same Markdown differently.
 */
export function ReadingMarkdown({ content, className }: { content: string; className?: string }) {
  const { document, outline } = React.useMemo(() => {
    let read: ProseMirrorDocument;
    try {
      read = withReadingAnchors(
        pruneForReading(parseMarkdown(content, { assignBlockIds: false }).document),
      );
    } catch {
      read = { type: 'doc', content: [] };
    }
    return { document: read, outline: readOutlineFromJson(read) };
  }, [content]);
  return (
    <ReadingOutlineContext.Provider value={outline}>
      <div className={className}>{renderBlockChildren(document.content, 'reading')}</div>
    </ReadingOutlineContext.Provider>
  );
}

/**
 * Copies the raw, unrendered Markdown of an answer to the clipboard.
 *
 * Once the answer is rendered (this issue), its Markdown source is otherwise
 * unreachable -- and that source is exactly what one would want to paste
 * onward, so a copy button ships alongside the renderer rather than later.
 */
/** A `[[page]]` reference: shown, not followed, because the chat has no page routes to resolve it against. */
function WikiReference({ children }: { children: React.ReactNode }) {
  const t = useTranslations('ai.message');
  return (
    <span className="italic text-muted-foreground" title={t('wikiLink')}>
      {children}
    </span>
  );
}

export function CopyMarkdownButton({ markdown }: { markdown: string }) {
  const t = useTranslations('ai.message');
  const [copied, setCopied] = React.useState(false);

  const copy = async (): Promise<void> => {
    await window.navigator.clipboard.writeText(markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copied ? t('copiedMarkdown') : t('copyMarkdown')}
            data-testid="chat-copy-markdown"
            onClick={() => void copy()}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        }
      />
      <TooltipContent>{copied ? t('copiedTooltip') : t('copyTooltip')}</TooltipContent>
    </Tooltip>
  );
}
