import { ADDRESSABLE_BLOCK_TYPES, BLOCK_ID_ATTRIBUTE, isValidBlockId } from '../block-id';
import {
  type MarkdownTokenHandlerContext,
  type ProseMirrorDocument,
  type ProseMirrorMark,
  type ProseMirrorNode,
} from '../contract';
import { WIKI_LINK_IDENTITY_ATTRIBUTE } from '../link-target';

import { WIKI_LINK_SCHEME } from './serialize';

/** Block types that carry a stable identifier. */
const ADDRESSABLE_BLOCK_TYPES_SET = new Set<string>(ADDRESSABLE_BLOCK_TYPES);

/** A ` ^id` at the very end of a block's text, which is where Markdown puts it. */
export const BLOCK_ID_SUFFIX_PATTERN = /(?:^|\s)\^([a-z0-9]{8,32})$/;
const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

interface StackEntry {
  type: string;
  attrs: Record<string, unknown>;
  content: ProseMirrorNode[];
}

/**
 * The document under construction while the Markdown token stream is walked.
 *
 * This exists so the token handlers stay functions instead of closures over a
 * thousand-line body: every piece of parser state that used to live in
 * `parseMarkdown` -- the open node stack, the active marks, the buffered images
 * and the paragraph the callout header swallowed -- is held here and reached
 * through methods, which is what lets the handlers be split by token family.
 */
export class DocumentBuilder {
  private readonly root: StackEntry = { type: 'doc', attrs: {}, content: [] };
  private readonly stack: StackEntry[] = [this.root];
  private marks: ProseMirrorMark[] = [];
  /**
   * Images are block-level in the Exocortex schema, but Markdown places them
   * inline. They are buffered while an inline container is open and flushed as
   * siblings once that container closes.
   */
  private pendingImages: ProseMirrorNode[] = [];
  /**
   * How many upcoming `paragraph_close` tokens belong to a paragraph that was
   * never opened, because a callout header consumed all of its text.
   */
  private skippedParagraphs = 0;

  /** The marks every text node currently gets. */
  get activeMarks(): readonly ProseMirrorMark[] {
    return this.marks;
  }

  set activeMarks(next: readonly ProseMirrorMark[]) {
    this.marks = [...next];
  }

  /** The type of the innermost open node, `doc` when nothing is open. */
  get openType(): string {
    return (this.stack[this.stack.length - 1] as StackEntry).type;
  }

  get isSkippingParagraph(): boolean {
    return this.skippedParagraphs > 0;
  }

  skipNextParagraph(): void {
    this.skippedParagraphs += 1;
  }

  consumeSkippedParagraph(): void {
    this.skippedParagraphs -= 1;
  }

  openNode(type: string, attrs: Record<string, unknown> = {}): void {
    this.stack.push({ type, attrs, content: [] });
  }

  closeNode(): void {
    const entry = this.stack.pop();
    if (entry === undefined) return;
    this.extractTrailingBlockId(entry);
    const node: ProseMirrorNode = { type: entry.type };
    if (Object.keys(entry.attrs).length > 0) node.attrs = entry.attrs;
    if (entry.content.length > 0) node.content = entry.content;

    const dropEmptyWrapper =
      entry.type === 'paragraph' && entry.content.length === 0 && this.pendingImages.length > 0;
    if (!dropEmptyWrapper) this.top().content.push(node);

    if (this.pendingImages.length > 0 && (entry.type === 'paragraph' || entry.type === 'heading')) {
      this.top().content.push(...this.pendingImages);
      this.pendingImages = [];
    }
  }

  addNode(type: string, attrs: Record<string, unknown> = {}, content?: ProseMirrorNode[]): void {
    const node: ProseMirrorNode = { type };
    if (Object.keys(attrs).length > 0) node.attrs = attrs;
    if (content !== undefined && content.length > 0) node.content = content;
    this.top().content.push(node);
  }

  addPendingImage(node: ProseMirrorNode): void {
    this.pendingImages.push(node);
  }

  pushText(text: string, marks: readonly ProseMirrorMark[]): void {
    if (text.length === 0) return;
    const node: ProseMirrorNode = { type: 'text', text };
    if (marks.length > 0) node.marks = marks.map((mark) => ({ ...mark }));
    this.top().content.push(node);
  }

  /** Splits `[[Target|Label]]` occurrences into wiki link marks. */
  addText(text: string): void {
    WIKI_LINK_PATTERN.lastIndex = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKI_LINK_PATTERN.exec(text)) !== null) {
      this.pushText(text.slice(lastIndex, match.index), this.marks);
      const target = (match[1] ?? '').trim();
      const label = (match[2] ?? target).trim();
      this.pushText(label, [
        ...this.marks,
        {
          type: 'link',
          // No identity in the file -- `[[Titel]]` is an interchange format and
          // stays free of internal identifiers. `bindPageLinkIdentities` maps
          // the title back onto a document where the importer has a workspace.
          attrs: {
            href: `${WIKI_LINK_SCHEME}${target}`,
            title: null,
            target: null,
            [WIKI_LINK_IDENTITY_ATTRIBUTE]: null,
          },
        },
      ]);
      lastIndex = match.index + match[0].length;
    }
    this.pushText(text.slice(lastIndex), this.marks);
  }

  /**
   * The handler surface extensions get; see `MarkdownTokenHandlerContext`.
   *
   * Built once and kept, because the parse loop reaches for it on every single
   * token.
   */
  readonly tokenContext: MarkdownTokenHandlerContext = {
    openNode: (type, attrs) => this.openNode(type, attrs),
    closeNode: () => this.closeNode(),
    addNode: (type, attrs, content) => this.addNode(type, attrs, content),
    addTextNode: (type, text, attrs = {}) =>
      this.addNode(type, attrs, text.length > 0 ? [{ type: 'text', text }] : undefined),
    addText: (text) => this.addText(text),
    openMark: (type, attrs) => {
      this.marks = [...this.marks, attrs === undefined ? { type } : { type, attrs }];
    },
    closeMark: (type) => {
      this.marks = this.marks.filter((mark) => mark.type !== type);
    },
  };

  /** The finished document; an empty one still carries one empty paragraph. */
  finish(): ProseMirrorDocument {
    return {
      type: 'doc',
      content: this.root.content.length > 0 ? this.root.content : [{ type: 'paragraph' }],
    };
  }

  private top(): StackEntry {
    return this.stack[this.stack.length - 1] as StackEntry;
  }

  /** Moves a trailing ` ^id` from the last text node into the block attributes. */
  private extractTrailingBlockId(entry: StackEntry): void {
    if (!ADDRESSABLE_BLOCK_TYPES_SET.has(entry.type)) return;
    if (isValidBlockId(entry.attrs[BLOCK_ID_ATTRIBUTE])) return;
    const last = entry.content[entry.content.length - 1];
    if (last === undefined || last.type !== 'text' || last.text === undefined) return;
    const match = BLOCK_ID_SUFFIX_PATTERN.exec(last.text);
    if (match === null) return;
    const stripped = last.text.slice(0, match.index);
    if (stripped.length === 0) {
      entry.content.pop();
    } else {
      last.text = stripped;
    }
    entry.attrs[BLOCK_ID_ATTRIBUTE] = match[1] as string;
  }
}
