import { describe, expect, it } from 'vitest';

import { automationFailureReasonSchema } from '@exocortex/contracts';

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

  /**
   * The digest is the one template whose shape changes with what happened
   * (issue #106). Two things are worth asserting: it counts what it does not
   * list, and it never puts a whole comment in a mail.
   */
  it('lists comments per page and counts the rest', () => {
    const mail = renderMail({
      template: 'COMMENT_DIGEST',
      commentCount: 9,
      morePages: 2,
      pages: [
        {
          title: 'Claude Code Setup',
          url: 'https://exocortex.app/arbeitsbereich/w1/seite/d1',
          moreComments: 3,
          comments: [
            { authorName: 'Stefan', preview: 'Sollen wir den Hook rauswerfen?' },
            { authorName: 'Johanna', preview: 'Ja, der läuft doppelt.' },
          ],
        },
      ],
    });

    expect(mail.subject).toBe('eXocortex: 9 neue Kommentare auf 3 Seiten');
    expect(mail.text).toContain('- Stefan: „Sollen wir den Hook rauswerfen?“');
    expect(mail.text).toContain('- und 3 weitere');
    expect(mail.text).toContain('https://exocortex.app/arbeitsbereich/w1/seite/d1');
    expect(mail.text).toContain('Auf 2 weiteren Seiten');
  });

  it('reads as a sentence when there is exactly one comment', () => {
    const mail = renderMail({
      template: 'COMMENT_DIGEST',
      commentCount: 1,
      morePages: 0,
      pages: [
        {
          title: 'Projektideen',
          url: 'https://exocortex.app/arbeitsbereich/w1/seite/d2',
          moreComments: 0,
          comments: [{ authorName: 'Stefan', preview: 'Kurz notiert.' }],
        },
      ],
    });

    expect(mail.subject).toBe('eXocortex: Ein neuer Kommentar auf „Projektideen“');
    expect(mail.text).not.toContain('weitere');
    expect(mail.text).toContain('Einstellungen → Benachrichtigungen');
  });
});

describe('the mail an automation sends', () => {
  const base = {
    template: 'AUTOMATION_PAGE' as const,
    ruleName: 'Morgenübersicht',
    subject: 'Dein Tag',
    documentTitle: 'Eingang',
    url: 'https://exocortex.app/arbeitsbereich/w1/seite/d1',
    body: '## Heute\n\n- Steuer\n',
    truncated: false,
  };

  it('carries the page itself and says which rule sent it', () => {
    const mail = renderMail(base);
    expect(mail.subject).toBe('eXocortex: Dein Tag');
    expect(mail.text).toContain('Automation „Morgenübersicht"');
    expect(mail.text).toContain('- Steuer');
    expect(mail.text).toContain(base.url);
    expect(mail.text).not.toContain('abgeschnitten');
  });

  it('says when it was cut rather than ending mid-sentence', () => {
    const mail = renderMail({ ...base, truncated: true });
    expect(mail.text).toContain('abgeschnitten');
    expect(mail.text).toContain(base.url);
  });
});

describe('the mails that say an automation stopped working', () => {
  const common = {
    ruleName: 'Hermes benachrichtigen',
    reason: 'WEBHOOK_FAILED' as const,
    occurredAt: '2026-09-24T01:05:00.000Z',
    timeZone: 'Europe/Berlin',
    url: 'https://exocortex.app/arbeitsbereich/w1/automationen',
  };

  it('says that a switched-off rule does nothing until it is switched back on', () => {
    const mail = renderMail({ template: 'AUTOMATION_DISABLED', failures: 5, ...common });
    expect(mail.subject).toBe(
      'eXocortex: Automation „Hermes benachrichtigen“ hat sich abgeschaltet',
    );
    expect(mail.text).toContain('5-mal hintereinander');
    expect(mail.text).toContain('tut sie nichts mehr');
    expect(mail.text).toContain('nicht erreichbar');
    expect(mail.text).toContain(common.url);
  });

  it('shows the moment in the zone it was given, not in the server’s', () => {
    const mail = renderMail({ template: 'AUTOMATION_DISABLED', failures: 5, ...common });
    // 01:05 UTC is 03:05 in Berlin in September.
    expect(mail.text).toContain('03:05');
  });

  it('falls back to UTC, and says so, for a zone it cannot read', () => {
    const mail = renderMail({
      template: 'AUTOMATION_DISABLED',
      failures: 5,
      ...common,
      timeZone: 'Mars/Olympus',
    });
    expect(mail.text).toContain('01:05');
    expect(mail.text).toContain('(UTC)');
  });

  it('counts down to the switch-off after a failed scheduled run', () => {
    const many = renderMail({
      template: 'AUTOMATION_RUN_FAILED',
      failuresUntilDisabled: 4,
      ...common,
    });
    expect(many.subject).toBe(
      'eXocortex: Geplanter Lauf von „Hermes benachrichtigen“ ist fehlgeschlagen',
    );
    expect(many.text).toContain('Nach 4 weiteren Fehlschlägen');
    expect(many.text).toContain('nicht einzeln');

    const last = renderMail({
      template: 'AUTOMATION_RUN_FAILED',
      failuresUntilDisabled: 1,
      ...common,
    });
    expect(last.text).toContain('Scheitert der nächste Lauf auch');
  });

  it('has a sentence for every reason and never an empty one', () => {
    for (const reason of automationFailureReasonSchema.options) {
      const mail = renderMail({ template: 'AUTOMATION_DISABLED', failures: 2, ...common, reason });
      const line = mail.text.split('\n').find((row) => row.startsWith('Grund: '));
      expect(line?.length ?? 0, reason).toBeGreaterThan('Grund: '.length + 20);
    }
  });
});
