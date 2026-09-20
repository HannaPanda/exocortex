import { type MailMessage } from '@exocortex/contracts';

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
  send(input: { to: string; message: MailMessage }): Promise<unknown>;
}
