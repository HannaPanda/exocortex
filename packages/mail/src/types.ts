import { type Locale, type MailAcceptance, type MailMessage } from '@exocortex/contracts';

/**
 * A message after a template has chosen its words and the layout has drawn
 * them, and before the relay has seen it.
 *
 * Two bodies, one source: both parts are produced by `composeMail` from the
 * same `MailContent` (issue #109), so the text part is never an afterthought
 * and the HTML part never says something the text part does not.
 */
export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

/**
 * The one thing that talks SMTP.
 *
 * Both processes build one of these and nothing else opens a connection to the
 * relay: the API for the mails a request waits on, the worker for the ones a
 * queue carries. Keeping it to a single interface is what stops the second
 * sender from quietly growing its own TLS decisions.
 */
export interface MailTransport {
  /**
   * Hands one message to the relay.
   *
   * Resolves with what the relay said, which is acceptance and not delivery
   * (see `MailAcceptance`). Throws on anything else -- the caller decides
   * whether that blocks a request, fails a job, or is merely logged.
   */
  send(input: { to: string; message: RenderedMail }): Promise<MailAcceptance>;
  close(): Promise<void>;
}

/**
 * The transport plus the template catalogue: what a caller actually wants.
 *
 * `send` takes a named message rather than a subject and a body, so no caller
 * anywhere in this repository is in a position to put a string of its own in
 * front of a reader. See `mailMessageSchema`.
 *
 * `locale` is required, not defaulted: the language is the reader's
 * (ADR-062), and only the caller knows who that is. A default here would be
 * the place where a French account quietly gets German post.
 */
export interface Mailer {
  send(input: { to: string; message: MailMessage; locale: Locale }): Promise<MailAcceptance>;
  close(): Promise<void>;
}

/**
 * A refusal that will be refused again.
 *
 * SMTP separates the two cases and so does everything above this: a 4xx is the
 * relay saying "not now", a 5xx and a rejected recipient are it saying "not
 * this message". Retrying the second costs five attempts and changes nothing,
 * so the job is failed permanently instead -- which also means it stays in the
 * failed set where somebody can see it, rather than looking busy for eight
 * minutes first.
 */
export class PermanentMailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentMailError';
  }
}
