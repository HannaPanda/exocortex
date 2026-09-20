import { describe, expect, it } from 'vitest';

import { renderMail } from './render';

/**
 * The templates are short enough that a snapshot would only record typing.
 * What is worth asserting is the two things a reader acts on -- the link and
 * whether the mail claims to answer something they did -- because getting the
 * second one wrong turns an invitation into something that reads like
 * phishing.
 */
describe('renderMail', () => {
  it('tells someone who asked that they may ignore it', () => {
    const mail = renderMail({
      template: 'PASSWORD_RESET',
      name: 'Johanna',
      url: 'https://exocortex.app/reset?token=abc',
    });

    expect(mail.subject).toBe('eXocortex: Passwort zurücksetzen');
    expect(mail.text).toContain('https://exocortex.app/reset?token=abc');
    expect(mail.text).toContain('Wenn du das nicht angefordert hast');
  });

  it('never tells an invited person to ignore the mail', () => {
    const mail = renderMail({
      template: 'INVITATION',
      invitedByName: 'Johanna',
      workspaceName: 'Second Brain',
      url: 'https://exocortex.app/einladung/abc',
      expiresAt: '2026-10-01T09:00:00.000Z',
    });

    expect(mail.subject).toBe('eXocortex: Einladung zu „Second Brain“');
    expect(mail.text).toContain('Johanna hat dich zum Arbeitsbereich „Second Brain“');
    expect(mail.text).toContain('1. Oktober 2026');
    expect(mail.text).not.toContain('ignorieren');
  });

  it('invites into the deployment itself when there is no workspace', () => {
    const mail = renderMail({
      template: 'INVITATION',
      invitedByName: 'Johanna',
      workspaceName: null,
      url: 'https://exocortex.app/einladung/abc',
      expiresAt: '2026-10-01T09:00:00.000Z',
    });

    expect(mail.subject).toBe('eXocortex: Einladung');
    expect(mail.text).toContain('Johanna hat dich zu eXocortex eingeladen.');
  });

  it('greets the person a verification mail is addressed to', () => {
    const mail = renderMail({
      template: 'EMAIL_VERIFICATION',
      name: 'Stefan',
      url: 'https://exocortex.app/verify?token=abc',
    });

    expect(mail.subject).toBe('eXocortex: E-Mail-Adresse bestätigen');
    expect(mail.text.startsWith('Hallo Stefan,')).toBe(true);
  });
});
