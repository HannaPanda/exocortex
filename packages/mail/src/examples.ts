import { type MailMessage } from '@exocortex/contracts';

type Template = MailMessage['template'];

/**
 * One believable message per template, for looking at rather than for sending
 * (issue #109).
 *
 * Keyed by template name and typed as a complete record, so a template added
 * to `mailMessageSchema` without an example here is a type error: the
 * regression test over every template and `pnpm --filter @exocortex/mail
 * preview` both read this list, and a mail missing from it is a mail nobody
 * has looked at.
 *
 * Every value is invented. No address, title or name here belongs to anybody.
 */
export const MAIL_EXAMPLES: { [K in Template]: Extract<MailMessage, { template: K }> } = {
  EMAIL_VERIFICATION: {
    template: 'EMAIL_VERIFICATION',
    name: 'Stefan',
    url: 'https://exocortex.app/api/auth/verify-email?token=eyJhbGciOiJIUzI1NiJ9.beispiel',
  },
  PASSWORD_RESET: {
    template: 'PASSWORD_RESET',
    name: 'Stefan',
    url: 'https://exocortex.app/passwort-zuruecksetzen?token=beispiel-token-0123456789',
  },
  INVITATION: {
    template: 'INVITATION',
    invitedByName: 'Johanna',
    workspaceName: 'Second Brain',
    url: 'https://exocortex.app/einladung/beispiel-0123456789abcdef',
    expiresAt: '2026-10-01T09:00:00.000Z',
  },
  SHARE_GRANTED: {
    template: 'SHARE_GRANTED',
    sharedByName: 'Johanna',
    documentTitle: 'Reisekasse Herbst 2026: Belege, Abrechnung und wer noch wem etwas schuldet',
    permission: 'WRITE',
    scope: 'SUBTREE',
    url: 'https://exocortex.app/geteilt/beispiel-dokument',
    expiresAt: '2026-10-01T09:00:00.000Z',
  },
  SHARE_CHANGED: {
    template: 'SHARE_CHANGED',
    changedByName: 'Johanna',
    documentTitle: 'Reisekasse',
    permission: 'READ',
    scope: 'PAGE_ONLY',
    url: 'https://exocortex.app/geteilt/beispiel-dokument',
    expiresAt: null,
  },
  SHARE_REVOKED: {
    template: 'SHARE_REVOKED',
    revokedByName: 'Johanna',
    documentTitle: 'Reisekasse',
    url: 'https://exocortex.app/geteilt',
  },
  COMMENT_DIGEST: {
    template: 'COMMENT_DIGEST',
    commentCount: 9,
    morePages: 2,
    pages: [
      {
        title: 'Claude Code Setup',
        url: 'https://exocortex.app/arbeitsbereich/beispiel/seite/eins',
        moreComments: 3,
        comments: [
          { authorName: 'Stefan', preview: 'Sollen wir den Hook rauswerfen?' },
          { authorName: 'Johanna', preview: 'Ja, der läuft doppelt.' },
        ],
      },
      {
        title: 'Projektideen',
        url: 'https://exocortex.app/arbeitsbereich/beispiel/seite/zwei',
        moreComments: 0,
        comments: [{ authorName: 'Hermes', preview: 'Kurz notiert, Details folgen.' }],
      },
    ],
  },
  AUTOMATION_PAGE: {
    template: 'AUTOMATION_PAGE',
    ruleName: 'Morgenübersicht',
    subject: 'Dein Tag',
    documentTitle: 'Eingang',
    url: 'https://exocortex.app/arbeitsbereich/beispiel/seite/eingang',
    body: '## Heute\n\n- Steuerunterlagen sortieren\n- Arzttermin 14:30\n\n## Offen\n\n- Rückruf Vermieter',
    truncated: true,
  },
  AUTOMATION_DISABLED: {
    template: 'AUTOMATION_DISABLED',
    ruleName: 'Hermes benachrichtigen',
    reason: 'WEBHOOK_FAILED',
    failures: 5,
    occurredAt: '2026-09-24T01:05:00.000Z',
    timeZone: 'Europe/Berlin',
    url: 'https://exocortex.app/arbeitsbereich/beispiel/automationen',
  },
  AUTOMATION_RUN_FAILED: {
    template: 'AUTOMATION_RUN_FAILED',
    ruleName: 'Wochenrückblick',
    reason: 'AI_FAILED',
    occurredAt: '2026-09-24T05:00:00.000Z',
    timeZone: 'Europe/Berlin',
    failuresUntilDisabled: 4,
    url: 'https://exocortex.app/arbeitsbereich/beispiel/automationen',
  },
};
