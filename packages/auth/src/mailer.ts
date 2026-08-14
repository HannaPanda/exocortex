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

export interface InvitationEmailInput {
  to: string;
  /** Who invited them, by name. An invitation from nobody is a phishing mail. */
  invitedByName: string;
  /** Workspace they are invited into, or null for an instance-only invitation. */
  workspaceName: string | null;
  url: string;
  expiresAt: Date;
}

export interface Mailer {
  sendVerificationEmail(input: { to: string; name: string; url: string }): Promise<void>;
  sendPasswordResetEmail(input: { to: string; name: string; url: string }): Promise<void>;
  sendInvitationEmail(input: InvitationEmailInput): Promise<void>;
  close(): Promise<void>;
}

const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'long' });

/**
 * The invitation mail.
 *
 * Written separately from `textEmail` rather than squeezed into it, because the
 * closing line of the other two ("falls du das nicht angefordert hast") is wrong
 * here: nobody requests an invitation, it arrives unasked. An unexpected mail
 * that tells you to ignore it reads like phishing, so this one names the person
 * who sent it and says plainly that the address can simply be left alone.
 */
function invitationEmail(input: {
  invitedByName: string;
  workspaceName: string | null;
  url: string;
  expiresAt: Date;
}): string {
  const destination =
    input.workspaceName === null
      ? 'zu eXocortex eingeladen'
      : `zum Arbeitsbereich „${input.workspaceName}“ in eXocortex eingeladen`;
  return [
    'Hallo,',
    '',
    `${input.invitedByName} hat dich ${destination}.`,
    '',
    'Über diesen Link legst du dein Konto an:',
    '',
    input.url,
    '',
    `Der Link gilt bis zum ${dateFormat.format(input.expiresAt)} und lässt sich nur einmal verwenden.`,
    '',
    'Wenn du damit nichts zu tun hast, brauchst du nichts zu unternehmen: ohne diesen',
    'Link entsteht kein Konto.',
    '',
    'eXocortex',
  ].join('\n');
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
    kind: 'verification' | 'password_reset' | 'invitation',
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
    async sendInvitationEmail({ to, invitedByName, workspaceName, url, expiresAt }) {
      await send(
        to,
        workspaceName === null
          ? 'eXocortex: Einladung'
          : `eXocortex: Einladung zu „${workspaceName}“`,
        invitationEmail({ invitedByName, workspaceName, url, expiresAt }),
        'invitation',
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
      logger.warn('Verification email suppressed (noop mailer)', {
        recipientDomain: to.split('@')[1],
      });
    },
    async sendPasswordResetEmail({ to }) {
      logger.warn('Password reset email suppressed (noop mailer)', {
        recipientDomain: to.split('@')[1],
      });
    },
    async sendInvitationEmail({ to }) {
      logger.warn('Invitation email suppressed (noop mailer)', {
        recipientDomain: to.split('@')[1],
      });
    },
    async close() {},
  };
}
