import { ADDRESSABLE_BLOCK_TYPES, BLOCK_ID_ATTRIBUTE, createBlockId } from './block-id';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';

/**
 * Copying one page's content into another page (issue #79, ADR-039).
 *
 * The one thing a copy may not keep is identity. Block ids are stable
 * addresses (ADR-003): comment anchors, the reference index and the source map
 * all resolve a block by its id, and two pages carrying the same id turn every
 * one of those into a question with two answers. So the structure is copied
 * and the addresses are new.
 *
 * What a copy *does* keep is every reference outwards -- links, mentions,
 * embedded databases, attachments. Those name something that exists once and
 * is not being copied, and rewriting them would be inventing content the
 * template did not contain. Two of them are worth saying out loud afterwards,
 * which is what the collected ids are for.
 */

const ADDRESSABLE = new Set<string>(ADDRESSABLE_BLOCK_TYPES);

/** How an attachment is referenced from a media node: by its download URL. */
const ATTACHMENT_URL_PATTERN = /\/api\/attachments\/([A-Za-z0-9_-]+)\/download/g;

export interface DocumentCopy {
  document: ProseMirrorDocument;
  /** Attachments the copy points at. They keep belonging to the original page. */
  attachmentIds: string[];
  /** Databases the copy embeds. Both pages then show the same one. */
  embeddedDatabaseIds: string[];
}

export function copyDocumentForNewPage(source: ProseMirrorDocument): DocumentCopy {
  const attachmentIds = new Set<string>();
  const embeddedDatabaseIds = new Set<string>();

  const copyNode = (node: ProseMirrorNode): ProseMirrorNode => {
    const attrs = node.attrs === undefined ? undefined : { ...node.attrs };

    if (attrs !== undefined) {
      if (ADDRESSABLE.has(node.type)) attrs[BLOCK_ID_ATTRIBUTE] = createBlockId();
      if (node.type === 'databaseEmbed' && typeof attrs.documentId === 'string') {
        if (attrs.documentId.length > 0) embeddedDatabaseIds.add(attrs.documentId);
      }
      for (const value of Object.values(attrs)) {
        if (typeof value !== 'string') continue;
        for (const match of value.matchAll(ATTACHMENT_URL_PATTERN)) {
          const id = match[1];
          if (id !== undefined) attachmentIds.add(id);
        }
      }
    } else if (ADDRESSABLE.has(node.type)) {
      // A block that arrived without attributes still needs an address.
      return {
        ...node,
        attrs: { [BLOCK_ID_ATTRIBUTE]: createBlockId() },
        ...(node.content === undefined ? {} : { content: node.content.map(copyNode) }),
      };
    }

    return {
      ...node,
      ...(attrs === undefined ? {} : { attrs }),
      ...(node.marks === undefined ? {} : { marks: node.marks.map((mark) => ({ ...mark })) }),
      ...(node.content === undefined ? {} : { content: node.content.map(copyNode) }),
    };
  };

  const copied = copyNode(source) as ProseMirrorDocument;
  return {
    document: copied,
    attachmentIds: [...attachmentIds],
    embeddedDatabaseIds: [...embeddedDatabaseIds],
  };
}
