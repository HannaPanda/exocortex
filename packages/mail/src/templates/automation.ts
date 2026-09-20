import { type RenderedMail } from '../types';

/**
 * The mail an `EMAIL_SELF` automation sends (issue #104, ADR-054).
 *
 * Every other template here is *about* something and keeps the thing itself
 * behind a link. This one is the thing: somebody wrote a rule saying "send me
 * this page every morning at seven", and a mail that answered that with a link
 * would be a notification they did not ask for.
 *
 * That only works because of who is reading it. The action has no recipient
 * field, so the address is always the account that owns the rule -- which is
 * also why the subject may be theirs to choose. Two lines of provenance go
 * above the page anyway: a mail that arrives at 07:00 with no sender context
 * is one somebody deletes as a newsletter.
 */

export function automationPageMail(input: {
  ruleName: string;
  subject: string;
  documentTitle: string;
  url: string;
  body: string;
  /** Whether the page goes on past what `body` holds. */
  truncated: boolean;
}): RenderedMail {
  const tail = input.truncated
    ? [
        '',
        '(Hier ist die Seite abgeschnitten. Den Rest liest du am besten in eXocortex.)',
        '',
        input.url,
      ]
    : ['', 'Die Seite in eXocortex:', '', input.url];

  return {
    // Prefixed like every other mail from here, even though the words after it
    // are the reader's own: a subject line that could be mistaken for a mail
    // somebody else sent is one that gets answered instead of read.
    subject: `eXocortex: ${input.subject}`,
    text: [
      `Automation „${input.ruleName}" schickt dir die Seite „${input.documentTitle}".`,
      '',
      '---',
      '',
      input.body,
      ...tail,
      '',
      'eXocortex',
    ].join('\n'),
  };
}
