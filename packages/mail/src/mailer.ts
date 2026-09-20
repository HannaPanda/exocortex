import { type MailAcceptance } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { renderMail } from './render';
import { createMailTransport, createNoopMailTransport } from './transport';
import { type Mailer, type MailTransport } from './types';

/**
 * A mailer over a transport: render, send, log what may be logged.
 *
 * What may be logged is the template name and the recipient's domain. Not the
 * address, not the subject, not a line of the body -- a mail is somebody's
 * post, and a log file is read by more people and kept for longer than
 * anything the mail itself passes through (`docs/observability.md`).
 */
export function createMailer(options: { transport: MailTransport; logger: Logger }): Mailer {
  const { transport, logger } = options;
  return {
    async send({ to, message }): Promise<MailAcceptance> {
      const template = message.template;
      try {
        const acceptance = await transport.send({ to, message: renderMail(message) });
        // "accepted", not "delivered": the relay has the message and owes us
        // the next hop. Whether an inbox ever shows it is not knowable here.
        logger.info('Mail accepted by the relay', {
          template,
          recipientDomain: domainOf(to),
          messageId: acceptance.messageId,
        });
        return acceptance;
      } catch (error) {
        logger.error('Failed to hand a mail to the relay', error, {
          template,
          recipientDomain: domainOf(to),
        });
        // Never swallowed: the caller decides whether a failed mail blocks a
        // request, fails a job, or is merely recorded.
        throw error;
      }
    },
    async close() {
      await transport.close();
    },
  };
}

/** The part of an address that is not a person. */
function domainOf(address: string): string | null {
  return address.split('@')[1] ?? null;
}

/**
 * The mailer a process builds from its environment.
 *
 * One function so the API and the worker cannot end up with two different
 * relays, and so neither of them has to know that "no host" is an allowed
 * state. It is: a deployment without SMTP configured logs its mails instead of
 * sending them, and nothing else about it changes.
 */
export function createMailerFromEnv(options: {
  host: string;
  port: number;
  from: string;
  user?: string | undefined;
  password?: string | undefined;
  logger: Logger;
}): Mailer {
  const { logger } = options;
  const transport =
    options.host.trim().length === 0
      ? createNoopMailTransport(logger)
      : createMailTransport(options);
  return createMailer({ transport, logger });
}

/** Renders nothing and sends nothing; for tests and for a relay-less deployment. */
export function createNoopMailer(logger: Logger): Mailer {
  return createMailer({ transport: createNoopMailTransport(logger), logger });
}
