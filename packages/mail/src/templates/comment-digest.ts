import { type MailBlock, type MailContent } from '../layout/content';
import { type MailLanguage } from '../translator';

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

export function commentDigestMail(
  input: {
    commentCount: number;
    pages: readonly CommentDigestPage[];
    morePages: number;
  },
  { t }: MailLanguage,
): MailContent {
  const counts = { count: input.commentCount, pages: input.pages.length + input.morePages };
  const firstPage = input.pages[0];
  const single = input.commentCount === 1 && firstPage !== undefined;

  const blocks: MailBlock[] = [
    { kind: 'paragraph', text: t('commentDigest.intro', { count: input.commentCount }) },
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
        ? { more: t('commentDigest.moreComments', { count: page.moreComments }) }
        : {}),
      link: { label: t('commentDigest.toPage'), url: page.url },
    });
  }

  if (input.morePages > 0) {
    blocks.push({
      kind: 'paragraph',
      text: t('commentDigest.morePages', { count: input.morePages }),
    });
  }

  return {
    subject: t('common.subject', {
      subject: single
        ? t('commentDigest.subjectSingle', { title: firstPage.title })
        : t('commentDigest.subject', counts),
    }),
    preheader: single
      ? t('commentDigest.preheaderSingle', {
          author: firstPage.comments[0]?.authorName ?? t('common.someone'),
        })
      : t('commentDigest.preheader', counts),
    heading: t('commentDigest.heading', { count: input.commentCount }),
    greeting: t('common.greeting'),
    blocks,
    footer: [t('commentDigest.footer')],
  };
}
