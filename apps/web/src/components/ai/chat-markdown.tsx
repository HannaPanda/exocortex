'use client';

import { CheckIcon, CopyIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  highlightCode,
  type HighlightNode,
  parseMarkdown,
  type ProseMirrorDocument,
  type ProseMirrorNode,
  pruneForChat,
  pruneForReading,
  WIKI_LINK_SCHEME,
} from '@exocortex/editor';
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

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

/**
 * Parses `content` into the chat's ProseMirror subset, throttled to roughly
 * once every {@link PARSE_THROTTLE_MS} while `streaming` is true and memoized
 * against the last parsed string. Always parses immediately once `streaming`
 * turns `false`, so the final render reflects the complete answer.
 */
function useChatMarkdownDocument(content: string, streaming: boolean): ProseMirrorDocument {
  // The lazy initializer is a pure function of `content`; everything that
  // follows only ever mutates refs from inside an effect or a callback, never
  // synchronously during render (React's rules of components and hooks).
  const [document, setDocument] = React.useState<ProseMirrorDocument>(() =>
    parseChatMarkdown(content),
  );

  const contentRef = React.useRef(content);
  const cacheRef = React.useRef<{ content: string; document: ProseMirrorDocument }>({
    content,
    document,
  });
  const timerRef = React.useRef<number | null>(null);
  // `null` until the first parse; an unset "last parsed at" must not throttle
  // that first parse, which is why the effect below treats it as "long ago".
  const lastParseAtRef = React.useRef<number | null>(null);

  const parseNow = React.useCallback(() => {
    const latest = contentRef.current;
    if (cacheRef.current.content === latest) return;
    const parsed = parseChatMarkdown(latest);
    cacheRef.current = { content: latest, document: parsed };
    lastParseAtRef.current = Date.now();
    setDocument(parsed);
  }, []);

  React.useEffect(() => {
    contentRef.current = content;
    if (cacheRef.current.content === content) return;

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

  return document;
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
 */
function ChatCodeBlock({ node, keyPrefix }: { node: ProseMirrorNode; keyPrefix: string }) {
  const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
  const text = React.useMemo(
    () => (node.content ?? []).map((child) => child.text ?? '').join(''),
    [node.content],
  );
  const highlighted = React.useMemo(() => highlightCode(text, language), [text, language]);

  return (
    <pre className="mb-1.5 overflow-x-auto rounded-md border border-border bg-card p-3 font-mono text-xs last:mb-0">
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
      return (
        <Tag key={key} className={headingClassName(level)}>
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

    case 'bulletList':
      return (
        <ul key={key} className="mb-1.5 list-disc space-y-0.5 pl-5 last:mb-0">
          {renderBlockChildren(node.content, key)}
        </ul>
      );

    case 'orderedList': {
      const start = typeof node.attrs?.start === 'number' ? node.attrs.start : 1;
      return (
        <ol key={key} start={start} className="mb-1.5 list-decimal space-y-0.5 pl-5 last:mb-0">
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
      // The two blocks only `pruneForReading` keeps, and then nothing:
      // `pruneForChat` already removed everything else, and this guards
      // against a future node type slipping through.
      return renderReadingBlock(node, key);
  }
}

/**
 * The blocks a page has and a chat bubble does not (issue #83, ADR-044).
 *
 * Only ever reached through `ReadingMarkdown`: `pruneForChat` drops both, so a
 * model's answer can never put an image on screen, which is what keeps a reply
 * from making the reader's browser fetch an address the model chose.
 */
function renderReadingBlock(node: ProseMirrorNode, key: string): React.ReactNode {
  if (node.type === 'horizontalRule') return <hr key={key} className="my-6 border-border" />;
  if (node.type !== 'image') return null;

  const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
  const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
  if (src.length === 0) return null;
  return <ZoomableImage key={key} src={src} alt={alt} />;
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
  const document = useChatMarkdownDocument(content, streaming);
  return <div className={className}>{renderBlockChildren(document.content, 'block')}</div>;
}

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
  const document = React.useMemo(() => {
    try {
      return pruneForReading(parseMarkdown(content, { assignBlockIds: false }).document);
    } catch {
      return { type: 'doc', content: [] } as ProseMirrorDocument;
    }
  }, [content]);
  return <div className={className}>{renderBlockChildren(document.content, 'reading')}</div>;
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
