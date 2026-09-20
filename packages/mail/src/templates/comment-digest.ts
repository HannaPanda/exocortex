import { type RenderedMail } from '../types';

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
}): RenderedMail {
  const pageCount = input.pages.length + input.morePages;
  const subject =
    input.commentCount === 1 && input.pages[0] !== undefined
      ? `eXocortex: Ein neuer Kommentar auf „${input.pages[0].title}“`
      : `eXocortex: ${input.commentCount} neue Kommentare auf ${pageWord(pageCount)}`;

  const lines: string[] = ['Hallo,', ''];
  lines.push(
    input.commentCount === 1
      ? 'auf einer Seite, an der du hängst, ist ein neuer Kommentar dazugekommen:'
      : `auf Seiten, an denen du hängst, sind ${input.commentCount} neue Kommentare dazugekommen:`,
    '',
  );

  for (const page of input.pages) {
    lines.push(page.title);
    for (const comment of page.comments) {
      lines.push(`- ${comment.authorName}: „${comment.preview}“`);
    }
    if (page.moreComments > 0) {
      lines.push(
        page.moreComments === 1 ? '- und ein weiterer' : `- und ${page.moreComments} weitere`,
      );
    }
    lines.push(page.url, '');
  }

  if (input.morePages > 0) {
    lines.push(
      input.morePages === 1
        ? 'Auf einer weiteren Seite ist ebenfalls etwas passiert.'
        : `Auf ${input.morePages} weiteren Seiten ist ebenfalls etwas passiert.`,
      '',
    );
  }

  lines.push(
    'Diese Mail bekommst du, weil du unter Einstellungen → Benachrichtigungen',
    'Kommentare per E-Mail eingeschaltet hast. Dort lässt sie sich auch wieder',
    'abstellen oder auf einmal täglich umstellen.',
    '',
    'eXocortex',
  );

  return { subject, text: lines.join('\n') };
}

/** „einer Seite" / „2 Seiten", so the subject reads like a sentence. */
function pageWord(count: number): string {
  return count === 1 ? 'einer Seite' : `${count} Seiten`;
}
