import { type MailBlock, type MailContent } from '../layout/content';

/**
 * The comments somebody has collected, as one mail (issue #106, ADR-053).
 *
 * One template for both modes, because the two mails are the same mail with a
 * different amount in it. `IMMEDIATE` collects a couple of minutes, a daily
 * digest collects a day, and a second "one new comment" template would be
 * these words with the plural removed and a copy to keep in step for ever.
 *
 * It carries previews and links and never a whole comment. Not because a
 * comment is long -- most are two lines -- but because a mail that repeats the
 * discussion is a mail people answer by replying to it, and nothing here reads
 * replies. The preview says what it is about; the link is where it happens.
 */

export interface CommentDigestPage {
  title: string;
  url: string;
  comments: readonly { authorName: string; preview: string }[];
  moreComments: number;
}

export function commentDigestMail(input: {
  commentCount: number;
  pages: readonly CommentDigestPage[];
  morePages: number;
}): MailContent {
  const pageCount = input.pages.length + input.morePages;
  const single = input.commentCount === 1 && input.pages[0] !== undefined;
  const subject = single
    ? `eXocortex: Ein neuer Kommentar auf „${input.pages[0]?.title ?? ''}“`
    : `eXocortex: ${input.commentCount} neue Kommentare auf ${pageWord(pageCount)}`;

  const blocks: MailBlock[] = [
    {
      kind: 'paragraph',
      text:
        input.commentCount === 1
          ? 'auf einer Seite, an der du hängst, ist ein neuer Kommentar dazugekommen:'
          : `auf Seiten, an denen du hängst, sind ${input.commentCount} neue Kommentare dazugekommen:`,
    },
  ];

  for (const page of input.pages) {
    blocks.push({
      kind: 'section',
      title: page.title,
      items: page.comments.map((comment) => ({
        label: comment.authorName,
        text: comment.preview,
        quoted: true,
      })),
      ...(page.moreComments > 0
        ? {
            more: page.moreComments === 1 ? 'und ein weiterer' : `und ${page.moreComments} weitere`,
          }
        : {}),
      link: { label: 'Zur Seite', url: page.url },
    });
  }

  if (input.morePages > 0) {
    blocks.push({
      kind: 'paragraph',
      text:
        input.morePages === 1
          ? 'Auf einer weiteren Seite ist ebenfalls etwas passiert.'
          : `Auf ${input.morePages} weiteren Seiten ist ebenfalls etwas passiert.`,
    });
  }

  return {
    subject,
    preheader: single
      ? `${input.pages[0]?.comments[0]?.authorName ?? 'Jemand'} hat kommentiert.`
      : `${input.commentCount} neue Kommentare auf ${pageWord(pageCount)}.`,
    heading:
      input.commentCount === 1 ? 'Ein neuer Kommentar' : `${input.commentCount} neue Kommentare`,
    greeting: 'Hallo,',
    blocks,
    footer: [
      'Diese Mail bekommst du, weil du unter Einstellungen → Benachrichtigungen Kommentare per E-Mail eingeschaltet hast. Dort lässt sie sich auch wieder abstellen oder auf einmal täglich umstellen.',
    ],
  };
}

/** „einer Seite" / „2 Seiten", so the subject reads like a sentence. */
function pageWord(count: number): string {
  return count === 1 ? 'einer Seite' : `${count} Seiten`;
}
