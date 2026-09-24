import { createTransport, type Transporter } from 'nodemailer';

import { type MailAcceptance } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { type MailTransport, PermanentMailError } from './types';

/**
 * The SMTP connection, and the only place in this repository that has one.
 *
 * Locally this talks to Mailpit (see docker-compose.yml); in production it is
 * Brevo, and any other relay works the same way. The TLS decisions below are
 * the reason this is a package rather than a helper next to whoever needed it
 * first: they have to be made once, and a second copy of them is a second
 * chance to get them wrong.
 */
export interface MailTransportOptions {
  host: string;
  port: number;
  from: string;
  /** Relay credentials. Both or neither; see below. */
  user?: string | undefined;
  password?: string | undefined;
  logger: Logger;
}

export function createMailTransport(options: MailTransportOptions): MailTransport {
  const hasCredentials =
    options.user !== undefined &&
    options.user.length > 0 &&
    options.password !== undefined &&
    options.password.length > 0;

  const transporter: Transporter = createTransport({
    host: options.host,
    port: options.port,
    // `secure` means TLS from the first byte, which is port 465. Submission on
    // 587 starts in the clear and upgrades, so it stays false in both cases.
    secure: options.port === 465,
    ...(hasCredentials
      ? {
          // A password is being sent, so an upgrade to TLS is not optional:
          // `requireTLS` makes nodemailer abort rather than fall back to a
          // plaintext session if the relay does not offer STARTTLS.
          requireTLS: true,
          auth: { user: options.user as string, pass: options.password as string },
        }
      : {
          // Mailpit and other loopback relays speak no TLS and want no login.
          ignoreTLS: true,
        }),
  });

  return {
    async send({ to, message }): Promise<MailAcceptance> {
      let info: SendMailInfo;
      try {
        info = (await transporter.sendMail({
          from: options.from,
          to,
          subject: message.subject,
          // nodemailer sends both as multipart/alternative, text first, so a
          // client that shows no HTML shows the equivalent text instead.
          text: message.text,
          html: message.html,
        })) as SendMailInfo;
      } catch (error) {
        // Neither the subject nor the body nor the address is logged here; the
        // callers add the recipient's domain and the template name, which is
        // what a person debugging a relay actually needs.
        throw classify(error);
      }

      const accepted = info.accepted ?? [];
      const rejected = info.rejected ?? [];
      if (accepted.length === 0) {
        // The relay answered, and it answered no. A second attempt sends the
        // same envelope to the same relay.
        throw new PermanentMailError(
          `The relay accepted no recipient (rejected ${rejected.length})`,
        );
      }
      return { messageId: info.messageId ?? null, accepted, rejected };
    },
    async close() {
      transporter.close();
    },
  };
}

/** Only the fields of nodemailer's result this cares about. */
interface SendMailInfo {
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
}

/**
 * Decides whether a failure is worth another attempt.
 *
 * SMTP already answers this and the answer is in the reply code: 4xx is a
 * temporary condition the relay expects to recover from, 5xx is a refusal of
 * this message. Anything without a code is a socket that broke or a name that
 * would not resolve, and those are exactly the faults a retry is for.
 */
function classify(error: unknown): Error {
  const responseCode = (error as { responseCode?: unknown }).responseCode;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof responseCode === 'number' && responseCode >= 500 && responseCode < 600) {
    return new PermanentMailError(`The relay refused the message (${responseCode}): ${message}`);
  }
  return error instanceof Error ? error : new Error(message);
}

/**
 * A transport that sends nothing and says so.
 *
 * For tests, and for a deployment that deliberately has no relay: every mail
 * then becomes a warning in the log carrying the recipient's domain and
 * nothing else, rather than a crash in whatever flow needed it.
 */
export function createNoopMailTransport(logger: Logger): MailTransport {
  return {
    async send({ to, message }): Promise<MailAcceptance> {
      logger.warn('Mail suppressed: no SMTP transport is configured', {
        recipientDomain: to.split('@')[1] ?? null,
        subjectLength: message.subject.length,
      });
      return { messageId: null, accepted: [to], rejected: [] };
    },
    async close() {},
  };
}
