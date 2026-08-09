import { type DocumentMigration, type ProseMirrorDocument } from './contract';
import { mapDocumentNodes } from './document-nodes';

/**
 * Schema version 4 gives the page link an identity.
 *
 * Until version 3 a `pageLink` stored only the title of its target, so renaming
 * a page silently broke every reference to it. Version 4 adds `documentId`
 * next to it (issue #14).
 *
 * The migration writes the attribute explicitly as `null` rather than relying
 * on the schema default: a stored document that has been through this is
 * indistinguishable from a freshly written one, which is what makes the
 * identity binding on import (`bindPageLinkIdentities`) a single, uniform
 * case instead of one for "absent" and one for "null".
 *
 * Nothing here can invent an identity — that needs a workspace and a database,
 * neither of which this package has. Old links keep resolving through their
 * title (`resolvePageLinkTarget`), and gain an identity the next time someone
 * edits them.
 */
export const SCHEMA_V4_MIGRATION: DocumentMigration = {
  fromVersion: 3,
  toVersion: 4,
  description: 'schema 4: page links carry the identity of their target',
  migrate: (document: ProseMirrorDocument): ProseMirrorDocument =>
    mapDocumentNodes(document, (node) => {
      if (node.type !== 'pageLink') return node;
      const documentId = node.attrs?.documentId;
      if (typeof documentId === 'string' && documentId.length > 0) return node;
      if (documentId === null) return node;
      return { ...node, attrs: { ...node.attrs, documentId: null } };
    }),
};
