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
  /** Relay credentials. Both or neither; see `createMailer`. */
  user?: string | undefined;
  password?: string | undefined;
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
    'eXocortex',
  ].join('\n');
}

export function createMailer(options: MailerOptions): Mailer {
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
        'eXocortex: E-Mail-Adresse bestätigen',
        textEmail(
          `Hallo ${name},`,
          'bitte bestätige deine E-Mail-Adresse für eXocortex über diesen Link:',
          url,
        ),
        'verification',
      );
    },
    async sendPasswordResetEmail({ to, name, url }) {
      await send(
        to,
        'eXocortex: Passwort zurücksetzen',
        textEmail(
          `Hallo ${name},`,
          'über diesen Link kannst du ein neues Passwort für eXocortex setzen:',
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
