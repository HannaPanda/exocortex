import { type RenderedMail } from '../types';

const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'long' });

/**
 * The invitation mail.
 *
 * Written separately from the two in `auth.ts` rather than squeezed in beside
 * them, because their closing line ("falls du das nicht angefordert hast") is
 * wrong here: nobody requests an invitation, it arrives unasked. An unexpected
 * mail that tells you to ignore it reads like phishing, so this one names the
 * person who sent it and says plainly that the address can simply be left
 * alone.
 */
export function invitationMail(input: {
  invitedByName: string;
  workspaceName: string | null;
  url: string;
  expiresAt: Date;
}): RenderedMail {
  const destination =
    input.workspaceName === null
      ? 'zu eXocortex eingeladen'
      : `zum Arbeitsbereich „${input.workspaceName}“ in eXocortex eingeladen`;
  return {
    subject:
      input.workspaceName === null
        ? 'eXocortex: Einladung'
        : `eXocortex: Einladung zu „${input.workspaceName}“`,
    text: [
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
    ].join('\n'),
  };
}
