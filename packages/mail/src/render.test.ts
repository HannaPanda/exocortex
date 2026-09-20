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

  it('names what a new share allows, how far it reaches and when it ends', () => {
    const mail = renderMail({
      template: 'SHARE_GRANTED',
      sharedByName: 'Johanna',
      documentTitle: 'Reisekasse',
      permission: 'WRITE',
      scope: 'SUBTREE',
      url: 'https://exocortex.app/geteilt/doc1',
      expiresAt: '2026-10-01T09:00:00.000Z',
    });

    expect(mail.subject).toBe('eXocortex: Johanna hat „Reisekasse“ mit dir geteilt');
    expect(mail.text).toContain('Erlaubt: Lesen und Bearbeiten');
    expect(mail.text).toContain('Umfang: Die Seite und alles, was darunter hängt');
    expect(mail.text).toContain('Gilt bis: 1. Oktober 2026');
    expect(mail.text).toContain('https://exocortex.app/geteilt/doc1');
  });

  it('says nothing about an expiry a grant does not have', () => {
    const mail = renderMail({
      template: 'SHARE_CHANGED',
      changedByName: 'Stefan',
      documentTitle: 'Reisekasse',
      permission: 'READ',
      scope: 'PAGE_ONLY',
      url: 'https://exocortex.app/geteilt/doc1',
      expiresAt: null,
    });

    expect(mail.subject).toBe('eXocortex: Deine Freigabe für „Reisekasse“ hat sich geändert');
    expect(mail.text).toContain('Erlaubt: Nur Lesen');
    expect(mail.text).toContain('Umfang: Nur diese eine Seite');
    expect(mail.text).not.toContain('Gilt bis');
  });

  /**
   * The one template that is defined by what it leaves out: after a
   * withdrawal the reader cannot check any of it, so a link into the page and
   * a permission line would be telling them about access they do not have.
   */
  it('hands a withdrawal no way back into the page', () => {
    const mail = renderMail({
      template: 'SHARE_REVOKED',
      revokedByName: 'Johanna',
      documentTitle: 'Reisekasse',
      url: 'https://exocortex.app/geteilt',
    });

    expect(mail.subject).toBe('eXocortex: Dein Zugang zu „Reisekasse“ ist beendet');
    expect(mail.text).toContain('zurückgezogen');
    expect(mail.text).toContain('https://exocortex.app/geteilt');
    expect(mail.text).not.toContain('/geteilt/');
    expect(mail.text).not.toContain('Erlaubt:');
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
