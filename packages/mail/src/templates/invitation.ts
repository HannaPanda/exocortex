import { type MailContent } from '../layout/content';
import { formatDay, type MailLanguage } from '../translator';

/**
 * The invitation mail.
 *
 * Written separately from the two in `auth.ts` rather than squeezed in beside
 * them, because their closing line ("falls du das nicht angefordert hast") is
 * wrong here: nobody requests an invitation, it arrives unasked. An unexpected
 * mail that tells you to ignore it reads like phishing, so this one names the
 * person who sent it and says plainly that the address can simply be left
 * alone.
 *
 * Its language is the one the inviter chose for it (`Invitation.locale`),
 * because the reader has no account yet whose choice could be asked.
 */
export function invitationMail(
  input: {
    invitedByName: string;
    workspaceName: string | null;
    url: string;
    expiresAt: Date;
  },
  language: MailLanguage,
): MailContent {
  const { t } = language;
  const invited =
    input.workspaceName === null
      ? t('invitation.invited', { inviter: input.invitedByName })
      : t('invitation.invitedWorkspace', {
          inviter: input.invitedByName,
          workspace: input.workspaceName,
        });
  return {
    subject: t('common.subject', {
      subject:
        input.workspaceName === null
          ? t('invitation.subject')
          : t('invitation.subjectWorkspace', { workspace: input.workspaceName }),
    }),
    preheader: invited,
    heading: t('invitation.heading'),
    greeting: t('common.greeting'),
    blocks: [
      { kind: 'paragraph', text: invited },
      { kind: 'action', label: t('invitation.action'), url: input.url },
      {
        kind: 'paragraph',
        text: t('invitation.validity', { date: formatDay(language, input.expiresAt) }),
      },
    ],
    footer: [t('invitation.footer')],
  };
}
