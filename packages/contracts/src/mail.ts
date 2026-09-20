import { z } from 'zod';

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
 * It follows that every field here is small and bounded. A page's text never
 * appears in a mail payload; a title, a name and a link do.
 */

/** A recipient address. Length is RFC 5321's limit for a mailbox. */
export const mailRecipientSchema = z.string().trim().min(3).max(320).includes('@');

const mailNameSchema = z.string().trim().min(1).max(200);
const mailUrlSchema = z.string().trim().min(1).max(2000);

/**
 * The templates, as a discriminated union.
 *
 * The three that exist are the ones this deployment already sent before there
 * was a queue: they were moved here unchanged, wording included, because a
 * refactor that also rewrites the password-reset mail is two changes wearing
 * one commit message.
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
