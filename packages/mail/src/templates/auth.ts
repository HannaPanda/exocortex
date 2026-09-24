import { type MailContent } from '../layout/content';

/**
 * The two mails Better Auth asks for: verify this address, set a new password.
 *
 * Both are answers to something the person just did, which is why they close
 * by saying the mail can be ignored. That sentence is wrong in an invitation
 * and right here, and it is the whole reason the two live in separate files.
 */

const IGNORE_LINE = 'Wenn du das nicht angefordert hast, kannst du diese E-Mail ignorieren.';

export function verificationMail(input: { name: string; url: string }): MailContent {
  return {
    subject: 'eXocortex: E-Mail-Adresse bestätigen',
    preheader: 'Ein Klick, dann ist deine Adresse bestätigt.',
    heading: 'E-Mail-Adresse bestätigen',
    greeting: `Hallo ${input.name},`,
    blocks: [
      { kind: 'paragraph', text: 'bitte bestätige deine E-Mail-Adresse für eXocortex.' },
      { kind: 'action', label: 'Adresse bestätigen', url: input.url },
    ],
    footer: [IGNORE_LINE],
  };
}

export function passwordResetMail(input: { name: string; url: string }): MailContent {
  return {
    subject: 'eXocortex: Passwort zurücksetzen',
    preheader: 'Über den Link in dieser Mail setzt du ein neues Passwort.',
    heading: 'Passwort zurücksetzen',
    greeting: `Hallo ${input.name},`,
    blocks: [
      {
        kind: 'paragraph',
        text: 'über den Link unten kannst du ein neues Passwort für eXocortex setzen.',
      },
      { kind: 'action', label: 'Neues Passwort setzen', url: input.url },
    ],
    footer: [IGNORE_LINE],
  };
}
