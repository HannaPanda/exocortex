import { type useFormatter, type useTranslations } from 'next-intl';

import { type DocumentShare } from '@exocortex/contracts';

/**
 * The words for one grant, shared by the page's share dialog and the list of
 * everything this account has handed out. Two places that describe the same
 * grant differently would be two answers to "what did I give away".
 */

type WordingTranslator = ReturnType<typeof useTranslations<'shares.wording'>>;
type Formatter = ReturnType<typeof useFormatter>;

/** One sentence per grant, in the words somebody would use about it. */
export function describeShare(
  share: DocumentShare,
  t: WordingTranslator,
  format: Formatter,
): string {
  const who =
    share.kind === 'PUBLIC_LINK'
      ? t('publicLink', { prefix: share.tokenPrefix ?? '' })
      : (share.grantee?.email ?? t('unknownAccount'));
  const values = {
    who,
    permission: share.permission,
    subtree: share.scope === 'SUBTREE' ? 'yes' : 'no',
  };
  return share.expiresAt === null
    ? t('grant', values)
    : t('grantUntil', {
        ...values,
        until: format.dateTime(new Date(share.expiresAt), { dateStyle: 'medium' }),
      });
}

/**
 * What withdrawing this grant actually costs, in facts the system already
 * knows.
 *
 * The same shape the trash confirmation uses: name what goes, name what cannot
 * be undone, and say nothing that is merely alarming. The two kinds cost
 * different things, and the difference is the whole reason this sentence
 * exists -- a public link's token is gone for good, while an account can be
 * invited again in the row above.
 */
export function revokeConsequence(
  share: DocumentShare,
  where: 'dialog' | 'list',
  t: WordingTranslator,
): string {
  const sentences =
    share.kind === 'PUBLIC_LINK'
      ? [t('revokeLink')]
      : [
          t('revokeAccount', { who: share.grantee?.email ?? t('thisAccount') }),
          where === 'dialog' ? t('regrantDialog') : t('regrantList'),
        ];
  if (share.scope === 'SUBTREE') sentences.push(t('revokeSubtree'));
  return sentences.join(' ');
}

/** A key of `shares.state`. */
export type ShareState = 'active' | 'expired' | 'revoked';

/**
 * Whether a grant still works. An expired grant has no `revokedAt` and would
 * read as live without this, although nobody can use it any more.
 */
export function shareStateOf(share: DocumentShare, now: number): ShareState {
  if (share.revokedAt !== null) return 'revoked';
  if (share.expiresAt !== null && new Date(share.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}
