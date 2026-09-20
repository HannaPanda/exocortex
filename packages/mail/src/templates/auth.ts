import { type RenderedMail } from '../types';

/**
 * The two mails Better Auth asks for: verify this address, set a new password.
 *
 * Both are answers to something the person just did, which is why they close
 * by saying the mail can be ignored. That sentence is wrong in an invitation
 * and right here, and it is the whole reason the two live in separate files.
 */

function requestedEmail(title: string, body: string, url: string): string {
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

export function verificationMail(input: { name: string; url: string }): RenderedMail {
  return {
    subject: 'eXocortex: E-Mail-Adresse bestätigen',
    text: requestedEmail(
      `Hallo ${input.name},`,
      'bitte bestätige deine E-Mail-Adresse für eXocortex über diesen Link:',
      input.url,
    ),
  };
}

export function passwordResetMail(input: { name: string; url: string }): RenderedMail {
  return {
    subject: 'eXocortex: Passwort zurücksetzen',
    text: requestedEmail(
      `Hallo ${input.name},`,
      'über diesen Link kannst du ein neues Passwort für eXocortex setzen:',
      input.url,
    ),
  };
}
