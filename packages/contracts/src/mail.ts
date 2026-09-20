import { z } from 'zod';

import { sharePermissionSchema, shareScopeSchema } from './shares';

/**
 * What a mail this deployment sends may say (issue #102).
 *
 * A message is named, never written by its caller: the queue carries a
 * template and the handful of values that template needs, and the words are
 * chosen in `@exocortex/mail` afterwards. That is the whole point of the
 * shape. A job payload holding a rendered subject and body would make the
 * queue a relay for whatever string reached it, and the things that will
 * enqueue mail next -- a share, an automation, a digest of somebody's
 * comments -- all carry text a person or a model wrote. A template cannot be
 * talked into saying something else.
 *
 * It follows that every field here is small and bounded. A title, a name and a
 * link is what a mail about something carries; the page itself stays behind
 * the link. The single exception is `AUTOMATION_PAGE` (issue #104), where the
 * mail *is* the page and the recipient can only ever be the person who asked
 * for it -- the comment on that variant says why that is a different question.
 */

/** A recipient address. Length is RFC 5321's limit for a mailbox. */
export const mailRecipientSchema = z.string().trim().min(3).max(320).includes('@');

const mailNameSchema = z.string().trim().min(1).max(200);
const mailUrlSchema = z.string().trim().min(1).max(2000);
/**
 * A page's title as a mail may carry it.
 *
 * Bounded like a name and never longer: a title is the one field here that a
 * person writes freely, and a subject line built from 4000 characters is a
 * subject line no client shows. The producer shortens; this refuses.
 */
const mailTitleSchema = z.string().trim().min(1).max(200);

/**
 * The templates, as a discriminated union.
 *
 * The first three are the ones this deployment already sent before there was a
 * queue: they were moved here unchanged, wording included, because a refactor
 * that also rewrites the password-reset mail is two changes wearing one commit
 * message. The share mails below them are the first that no request waits on.
 *
 * `expiresAt` is an ISO string rather than a `Date`: a payload makes a round
 * trip through JSON in Redis, and a `Date` comes back out of it as a string
 * whatever the type said.
 */
export const mailMessageSchema = z.discriminatedUnion('template', [
  z.object({
    template: z.literal('EMAIL_VERIFICATION'),
    name: mailNameSchema,
    url: mailUrlSchema,
  }),
  z.object({
    template: z.literal('PASSWORD_RESET'),
    name: mailNameSchema,
    url: mailUrlSchema,
  }),
  z.object({
    template: z.literal('INVITATION'),
    /** Who invited them, by name. An invitation from nobody is a phishing mail. */
    invitedByName: mailNameSchema,
    /** The workspace they are invited into, or null for an instance-only invitation. */
    workspaceName: z.string().trim().min(1).max(200).nullable(),
    url: mailUrlSchema,
    expiresAt: z.iso.datetime(),
  }),
  /**
   * A page was shared with an account (issue #103).
   *
   * Three templates rather than one with a `change` field, because the three
   * mails say different things and one of them says deliberately less: a
   * withdrawal carries no link into the page and no permission, since the
   * reader can no longer check either.
   */
  z.object({
    template: z.literal('SHARE_GRANTED'),
    sharedByName: mailNameSchema,
    documentTitle: mailTitleSchema,
    permission: sharePermissionSchema,
    scope: shareScopeSchema,
    url: mailUrlSchema,
    /** When the grant ends by itself, or null when it does not. */
    expiresAt: z.iso.datetime().nullable(),
  }),
  z.object({
    template: z.literal('SHARE_CHANGED'),
    changedByName: mailNameSchema,
    documentTitle: mailTitleSchema,
    /** The state after the change, never a before-and-after: one is enough to act on. */
    permission: sharePermissionSchema,
    scope: shareScopeSchema,
    url: mailUrlSchema,
    expiresAt: z.iso.datetime().nullable(),
  }),
  z.object({
    template: z.literal('SHARE_REVOKED'),
    revokedByName: mailNameSchema,
    /**
     * The title, and nothing else about the page.
     *
     * Defensible because it was in the mail that announced the share: the
     * reader already has it. What is not here is the link, the permission and
     * anything the page says -- a withdrawal must not hand over more than the
     * grant did.
     */
    documentTitle: mailTitleSchema,
    /** The list of pages still shared with them, not the page that was withdrawn. */
    url: mailUrlSchema,
  }),
  /**
   * The comments somebody has collected since the last time they were told
   * (issue #106, ADR-053).
   *
   * One template for both modes the pair offers. `IMMEDIATE` is a digest of
   * whatever arrived in the last couple of minutes and `DAILY_DIGEST` is a
   * digest of a day; a second, single-comment template would be the same mail
   * with the plural removed, and two templates to keep in step for that.
   *
   * Everything here is bounded twice over. The producer caps the lists and
   * counts what it left out in `moreComments` and `morePages`, and the schema
   * refuses anything longer -- a mail is a summary, and a person who wants the
   * whole thread follows the link.
   */
  z.object({
    template: z.literal('COMMENT_DIGEST'),
    /** Every comment this mail stands for, the ones it lists and the ones it counts. */
    commentCount: z.number().int().min(1),
    pages: z
      .array(
        z.object({
          title: mailTitleSchema,
          url: mailUrlSchema,
          comments: z
            .array(
              z.object({
                authorName: mailNameSchema,
                /** The comment's first words, flattened. Never the whole body. */
                preview: z.string().trim().min(1).max(200),
              }),
            )
            .min(1)
            .max(5),
          /** Comments on this page the mail does not list. */
          moreComments: z.number().int().min(0),
        }),
      )
      .min(1)
      .max(10),
    /** Pages the mail does not list at all. */
    morePages: z.number().int().min(0),
  }),
  /**
   * A page an automation sends to the person who wrote the rule (issue #104,
   * ADR-054).
   *
   * The one template that carries a page's text, and the one whose subject a
   * person chose, which is exactly the thing the comment at the top of this
   * file says a payload must not do. It is defensible here and nowhere else
   * because of who receives it: an `EMAIL_SELF` rule has no field naming a
   * recipient, the address is read from the owning account at the moment of
   * sending, and so the worst this template can carry is somebody's own page
   * to their own inbox. Change that -- let a rule name an address -- and this
   * variant has to go back to being a link.
   *
   * `body` is Markdown, already cut to `AUTOMATION_MAX_MAIL_CHARS` by the
   * producer; `truncated` is what lets the template say so instead of ending
   * mid-sentence and leaving the reader to wonder.
   */
  z.object({
    template: z.literal('AUTOMATION_PAGE'),
    ruleName: mailNameSchema,
    /** What the rule's owner typed, or the rule's name. Never a third thing. */
    subject: mailTitleSchema,
    documentTitle: mailTitleSchema,
    url: mailUrlSchema,
    body: z.string().max(10_000),
    truncated: z.boolean(),
  }),
]);
export type MailMessage = z.infer<typeof mailMessageSchema>;

export type MailTemplateName = MailMessage['template'];

/**
 * What the relay said when it took the message, which is not what the inbox
 * will say.
 *
 * Keeping the two apart is the reason this type exists at all. SMTP acceptance
 * means one hop succeeded: the relay has the message and has taken
 * responsibility for the next attempt. It is not delivery, it is not a read,
 * and a log line or a UI string that calls it "zugestellt" is claiming
 * something nobody in this process can know. `messageId` is the relay's own
 * handle for the queued message, and it is the only thing that could later be
 * matched against a bounce.
 */
export interface MailAcceptance {
  /** The relay's id for the queued message, when it gave one. */
  messageId: string | null;
  /** Addresses the relay took. */
  accepted: readonly string[];
  /** Addresses the relay refused outright; a non-empty list is a permanent failure. */
  rejected: readonly string[];
}
