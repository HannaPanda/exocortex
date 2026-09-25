import { type MailContent } from '../layout/content';
import { type MailLanguage } from '../translator';

/**
 * The two mails Better Auth asks for: verify this address, set a new password.
 *
 * Both are answers to something the person just did, which is why they close
 * by saying the mail can be ignored. That sentence is wrong in an invitation
 * and right here, and it is the whole reason the two live in separate files.
 */

export function verificationMail(
  input: { name: string; url: string },
  { t }: MailLanguage,
): MailContent {
  return {
    subject: t('common.subject', { subject: t('auth.verification.subject') }),
    preheader: t('auth.verification.preheader'),
    heading: t('auth.verification.heading'),
    greeting: t('common.greetingNamed', { name: input.name }),
    blocks: [
      { kind: 'paragraph', text: t('auth.verification.body') },
      { kind: 'action', label: t('auth.verification.action'), url: input.url },
    ],
    footer: [t('auth.ignore')],
  };
}

export function passwordResetMail(
  input: { name: string; url: string },
  { t }: MailLanguage,
): MailContent {
  return {
    subject: t('common.subject', { subject: t('auth.passwordReset.subject') }),
    preheader: t('auth.passwordReset.preheader'),
    heading: t('auth.passwordReset.heading'),
    greeting: t('common.greetingNamed', { name: input.name }),
    blocks: [
      { kind: 'paragraph', text: t('auth.passwordReset.body') },
      { kind: 'action', label: t('auth.passwordReset.action'), url: input.url },
    ],
    footer: [t('auth.ignore')],
  };
}
