import { type Locale, type MailMessage } from '@exocortex/contracts';

/**
 * What Better Auth's callbacks need in order to send a mail, and nothing else.
 *
 * A port rather than an implementation (issue #102). Sending mail is not an
 * authentication concern: the moment a share, an automation or a digest also
 * wants a relay, an SMTP transport living in this package means every one of
 * them depends on the authentication library to reach it. So the transport
 * moved to `@exocortex/mail` and what stays here is this interface, which
 * `@exocortex/mail`'s `Mailer` satisfies structurally.
 *
 * It takes a named message rather than a subject and a body for the same
 * reason the queue does: nothing in this repository should be in a position to
 * put a string of its own in front of a reader. The two messages Better Auth
 * sends are `EMAIL_VERIFICATION` and `PASSWORD_RESET`; the words are chosen in
 * `@exocortex/mail`.
 */
export interface AuthMailer {
  send(input: { to: string; message: MailMessage; locale: Locale }): Promise<unknown>;
}

/**
 * The headers a mail's language may be negotiated from when the account has
 * not chosen one: the request that caused the mail was made by its reader.
 */
export interface MailLocaleHeaders {
  cookie?: string | undefined;
  'accept-language'?: string | undefined;
}

/**
 * Which language a mail Better Auth sends is written in (issue #98, ADR-062).
 *
 * A port for the same reason as the mailer: the order -- the account's
 * `User.locale`, then this browser's cookie, then `Accept-Language`, then
 * German -- lives in `@exocortex/i18n`, and this package depends on neither
 * it nor the catalogue. Both mails Better Auth sends are read by the person
 * whose request caused them (a reset they asked for, the verification of the
 * address they just gave), so the request's headers are theirs.
 */
export type AuthMailLocale = (input: {
  userId: string;
  headers: MailLocaleHeaders;
}) => Promise<Locale>;
