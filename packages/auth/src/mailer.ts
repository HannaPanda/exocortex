import { createTransport, type Transporter } from 'nodemailer';

import { type Logger } from '@exocortex/logger';

/**
 * Transactional mail for verification and password reset.
 *
 * Locally this talks to Mailpit (see docker-compose.yml); in production any SMTP
 * relay works. Mail bodies are user-visible and therefore German, while log
 * messages stay English.
 */
export interface MailerOptions {
  host: string;
  port: number;
  from: string;
  logger: Logger;
}

export interface Mailer {
  sendVerificationEmail(input: { to: string; name: string; url: string }): Promise<void>;
  sendPasswordResetEmail(input: { to: string; name: string; url: string }): Promise<void>;
  close(): Promise<void>;
}

function textEmail(title: string, body: string, url: string): string {
  return [
    title,
    '',
    body,
    '',
    url,
    '',
    'Wenn du das nicht angefordert hast, kannst du diese E-Mail ignorieren.',
    '',
    'Exocortex',
  ].join('\n');
}

export function createMailer(options: MailerOptions): Mailer {
  const transporter: Transporter = createTransport({
    host: options.host,
    port: options.port,
    // Mailpit and most internal relays do not use TLS on the local network.
    secure: false,
    ignoreTLS: true,
  });

  const send = async (
    to: string,
    subject: string,
    text: string,
    kind: 'verification' | 'password_reset',
  ): Promise<void> => {
    try {
      await transporter.sendMail({ from: options.from, to, subject, text });
      options.logger.info('Transactional email sent', { kind });
    } catch (error) {
      // Never swallow: the caller decides whether a failed mail blocks the flow.
      options.logger.error('Failed to send transactional email', error, { kind });
      throw error;
    }
  };

  return {
    async sendVerificationEmail({ to, name, url }) {
      await send(
        to,
        'Exocortex: E-Mail-Adresse bestätigen',
        textEmail(
          `Hallo ${name},`,
          'bitte bestätige deine E-Mail-Adresse für Exocortex über diesen Link:',
          url,
        ),
        'verification',
      );
    },
    async sendPasswordResetEmail({ to, name, url }) {
      await send(
        to,
        'Exocortex: Passwort zurücksetzen',
        textEmail(
          `Hallo ${name},`,
          'über diesen Link kannst du ein neues Passwort für Exocortex setzen:',
          url,
        ),
        'password_reset',
      );
    },
    async close() {
      transporter.close();
    },
  };
}

/** Mailer that only logs. Used in tests and when SMTP is intentionally absent. */
export function createNoopMailer(logger: Logger): Mailer {
  return {
    async sendVerificationEmail({ to }) {
      logger.warn('Verification email suppressed (noop mailer)', { recipientDomain: to.split('@')[1] });
    },
    async sendPasswordResetEmail({ to }) {
      logger.warn('Password reset email suppressed (noop mailer)', {
        recipientDomain: to.split('@')[1],
      });
    },
    async close() {},
  };
}
