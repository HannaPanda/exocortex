import { z } from 'zod';

import { documentSummarySchema } from './documents';
import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * Page shares and scoped access (issue #83, ADR-044).
 *
 * Three things that look different in the UI are one row here: a link anybody
 * may open, a page handed to another account, and the subtree an agent token
 * is confined to. They are the same question asked about the same resource --
 * who may read or write this page -- and answering it in one place is what
 * keeps a new endpoint from quietly answering it differently.
 *
 * Two words carry the whole model:
 *
 *   permission  READ or WRITE. A public link is always READ; anonymous writing
 *               does not exist and is refused at the contract already.
 *   scope       PAGE_ONLY or SUBTREE. SUBTREE hangs off the hierarchy rather
 *               than off a list of ids, so moving a page inside the shared
 *               branch keeps it shared and moving it out ends the share.
 */

export const SHARE_PERMISSIONS = ['READ', 'WRITE'] as const;
export const sharePermissionSchema = z.enum(SHARE_PERMISSIONS);
export type SharePermission = z.infer<typeof sharePermissionSchema>;

export const SHARE_SCOPES = ['PAGE_ONLY', 'SUBTREE'] as const;
export const shareScopeSchema = z.enum(SHARE_SCOPES);
export type ShareScope = z.infer<typeof shareScopeSchema>;

/** Who a share is for. `USER` names an account, `PUBLIC_LINK` names nobody. */
export const SHARE_KINDS = ['USER', 'PUBLIC_LINK'] as const;
export const shareKindSchema = z.enum(SHARE_KINDS);
export type ShareKind = z.infer<typeof shareKindSchema>;

/** The person a `USER` share was granted to, as the owner sees them. */
export const shareGranteeSchema = z.object({
  id: idSchema,
  name: z.string(),
  email: z.string(),
});
export type ShareGrantee = z.infer<typeof shareGranteeSchema>;

export const documentShareSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  documentId: idSchema,
  /** Title and icon of the shared page, so a list does not need a second read. */
  documentTitle: z.string(),
  documentIcon: z.string().nullable(),
  kind: shareKindSchema,
  permission: sharePermissionSchema,
  scope: shareScopeSchema,
  /** Present for `USER`, null for a link. */
  grantee: shareGranteeSchema.nullable(),
  /**
   * The opaque part of the public address, `null` for a `USER` share **and**
   * for a link that was created in an earlier request: only the response to
   * the creating call carries the secret, exactly like an API token.
   */
  token: z.string().nullable(),
  /** First characters of the token, so a link is recognisable in a list. */
  tokenPrefix: z.string().nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  createdById: idSchema,
  createdByName: z.string(),
  createdAt: isoDateTimeSchema,
  /** Null while the share is live; set the moment it is withdrawn. */
  revokedAt: isoDateTimeSchema.nullable(),
});
export type DocumentShare = z.infer<typeof documentShareSchema>;

export const createShareRequestSchema = z
  .object({
    kind: shareKindSchema,
    /** Required for `USER`: the address of the account the page goes to. */
    email: z.string().trim().email().max(320).optional(),
    /** A public link may only ever be READ; the service refuses anything else. */
    permission: sharePermissionSchema.default('READ'),
    scope: shareScopeSchema.default('PAGE_ONLY'),
    /** Days until the share stops working. Null never expires. */
    expiresInDays: z.number().int().min(1).max(3_650).nullable().default(null),
  })
  .refine((value) => value.kind !== 'USER' || value.email !== undefined, {
    message: 'A share to an account needs the email address of that account',
    path: ['email'],
  })
  .refine((value) => value.kind !== 'PUBLIC_LINK' || value.permission === 'READ', {
    message: 'A public link is read-only',
    path: ['permission'],
  });
export type CreateShareRequest = z.infer<typeof createShareRequestSchema>;

export const updateShareRequestSchema = z.object({
  permission: sharePermissionSchema.optional(),
  scope: shareScopeSchema.optional(),
  /** `null` removes the expiry, a number sets a new one counted from now. */
  expiresInDays: z.number().int().min(1).max(3_650).nullable().optional(),
});
export type UpdateShareRequest = z.infer<typeof updateShareRequestSchema>;

export const shareResponseSchema = z.object({ share: documentShareSchema });
export type ShareResponse = z.infer<typeof shareResponseSchema>;

export const shareListResponseSchema = z.object({
  /** Grants attached to this page itself. */
  shares: z.array(documentShareSchema),
  /**
   * Grants this page is covered by because one of its ancestors was shared
   * with `SUBTREE`.
   *
   * In the same answer as the page's own grants, and not behind a second
   * request, because the dangerous case is exactly the one somebody would not
   * think to ask about: a page that was never shared and is readable from
   * outside anyway, because of a decision made three levels above it. A badge
   * that only knew about direct grants would be silent precisely there.
   */
  inherited: z.array(documentShareSchema),
});
export type ShareListResponse = z.infer<typeof shareListResponseSchema>;

export const revokeShareResponseSchema = z.object({ revoked: z.literal(true) });
export type RevokeShareResponse = z.infer<typeof revokeShareResponseSchema>;

/**
 * A page somebody else shared with me.
 *
 * Deliberately not a `DocumentShare`: the recipient is not told who else the
 * page was given to, nor whether a public link exists beside their own grant.
 * What they need is the page, what they may do with it, and who handed it over.
 */
export const incomingShareSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  /** The name of the workspace the page lives in, for orientation only. */
  workspaceName: z.string(),
  document: documentSummarySchema,
  permission: sharePermissionSchema,
  scope: shareScopeSchema,
  sharedByName: z.string(),
  sharedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema.nullable(),
});
export type IncomingShare = z.infer<typeof incomingShareSchema>;

export const incomingShareListResponseSchema = z.object({
  shares: z.array(incomingShareSchema),
});
export type IncomingShareListResponse = z.infer<typeof incomingShareListResponseSchema>;

export const outgoingShareListResponseSchema = z.object({
  shares: z.array(documentShareSchema),
});
export type OutgoingShareListResponse = z.infer<typeof outgoingShareListResponseSchema>;

// --------------------------------------------------------------------------
// The public side of a link
// --------------------------------------------------------------------------

/**
 * What an anonymous reader is given.
 *
 * A deliberately small shape, and not `DocumentDetail`: that one carries the
 * workspace id, the creator, the breadcrumb through pages the reader may not
 * see and the flags of a page that can be edited. None of it is any of an
 * anonymous reader's business, and leaving a field out is the only way to be
 * sure it is not rendered somewhere.
 */
export const publicSharePageSchema = z.object({
  documentId: idSchema,
  title: z.string(),
  icon: z.string().nullable(),
  /** Rendered content, Markdown, derived from the canonical Yjs state (ADR-007). */
  markdown: z.string(),
  updatedAt: isoDateTimeSchema,
  /**
   * Sub-pages a `SUBTREE` link also covers, direct children only, so a reader
   * can walk down without the whole tree being handed over at once. Empty for
   * a `PAGE_ONLY` link.
   */
  children: z.array(
    z.object({ documentId: idSchema, title: z.string(), icon: z.string().nullable() }),
  ),
  /**
   * The chain from the link's root down to this page, so a reader who has
   * walked into a sub-page can walk back. It stops at the root of the share:
   * where that root sits in the workspace is not part of what was shared.
   */
  path: z.array(z.object({ documentId: idSchema, title: z.string() })),
  /** Name of the workspace, shown as the source of the page. */
  workspaceName: z.string(),
  sharedByName: z.string(),
});
export type PublicSharePage = z.infer<typeof publicSharePageSchema>;

export const publicShareResponseSchema = z.object({ page: publicSharePageSchema });
export type PublicShareResponse = z.infer<typeof publicShareResponseSchema>;

// --------------------------------------------------------------------------
// Token page scopes
// --------------------------------------------------------------------------

/**
 * One page or subtree an API token is confined to (issue #83).
 *
 * A token with no scope at all keeps the authority it always had, which is the
 * account's. A token with one or more scopes can reach nothing else: not
 * through a route, not through search, not through a reference, and not
 * through a workspace-wide listing, which such a token is refused outright.
 */
export const apiTokenPageScopeSchema = z.object({
  documentId: idSchema,
  scope: shareScopeSchema,
  /** Title of the page, so the token list can say what it covers. */
  documentTitle: z.string(),
  workspaceId: idSchema,
});
export type ApiTokenPageScope = z.infer<typeof apiTokenPageScopeSchema>;

export const apiTokenPageScopeInputSchema = z.object({
  documentId: idSchema,
  scope: shareScopeSchema.default('SUBTREE'),
});
export type ApiTokenPageScopeInput = z.infer<typeof apiTokenPageScopeInputSchema>;
