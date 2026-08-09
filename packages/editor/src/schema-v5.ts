import { type DocumentMigration, type ProseMirrorDocument, type ProseMirrorMark } from './contract';
import { mapDocumentNodes } from './document-nodes';
import { WIKI_LINK_IDENTITY_ATTRIBUTE } from './link-target';

/**
 * Schema version 5 gives the link mark an identity.
 *
 * Version 4 did this for the `pageLink` block (issue #14) and left the far more
 * common notation alone: a `[[Titel]]` in running text is a `link` mark, and it
 * carried nothing but the title, so renaming a page still broke every mention
 * of it in prose (issue #24). Version 5 adds `documentId` next to the address.
 *
 * The attribute is added to *every* link mark, not only to the `wiki:` ones.
 * ProseMirror fills defaults in when it serializes a mark, so a freshly written
 * external link carries `documentId: null` too; writing it here as well is what
 * makes a migrated document indistinguishable from a new one, which in turn
 * keeps "absent" and "null" from being two cases the import has to tell apart.
 *
 * Nothing here can invent an identity — that needs a workspace and a database,
 * neither of which this package has. Old references keep resolving through
 * their title (`resolvePageLinkTarget`), and gain an identity the next time
 * someone edits them or the document passes the Markdown boundary
 * (`bindPageLinkIdentities`).
 */
export const SCHEMA_V5_MIGRATION: DocumentMigration = {
  fromVersion: 4,
  toVersion: 5,
  description: 'schema 5: link marks carry the identity of their target',
  migrate: (document: ProseMirrorDocument): ProseMirrorDocument =>
    mapDocumentNodes(document, (node) => {
      const marks = node.marks;
      if (marks === undefined) return node;

      let changed = false;
      const next = marks.map((mark): ProseMirrorMark => {
        if (mark.type !== 'link') return mark;
        if (mark.attrs !== undefined && WIKI_LINK_IDENTITY_ATTRIBUTE in mark.attrs) return mark;
        changed = true;
        return { ...mark, attrs: { ...mark.attrs, [WIKI_LINK_IDENTITY_ATTRIBUTE]: null } };
      });

      return changed ? { ...node, marks: next } : node;
    }),
};
