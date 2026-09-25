import { type MailContent } from '../layout/content';
import { type MailLanguage } from '../translator';

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

export function automationPageMail(
  input: {
    ruleName: string;
    subject: string;
    documentTitle: string;
    url: string;
    body: string;
    /** Whether the page goes on past what `body` holds. */
    truncated: boolean;
  },
  { t }: MailLanguage,
): MailContent {
  const words = { rule: input.ruleName, title: input.documentTitle };
  return {
    // Prefixed like every other mail from here, even though the words after it
    // are the reader's own: a subject line that could be mistaken for a mail
    // somebody else sent is one that gets answered instead of read.
    subject: t('common.subject', { subject: input.subject }),
    preheader: t('automationPage.preheader', words),
    heading: input.documentTitle,
    blocks: [
      { kind: 'paragraph', text: t('automationPage.body', words) },
      // The page as written: escaped, never rendered. Markdown stays Markdown,
      // because turning a page into markup is exactly the rich-content decision
      // this layout leaves to a block of its own (issue #109).
      { kind: 'excerpt', text: input.body },
      ...(input.truncated
        ? [{ kind: 'notice' as const, text: t('automationPage.truncated') }]
        : []),
      { kind: 'link', label: t('automationPage.link'), url: input.url },
    ],
  };
}
