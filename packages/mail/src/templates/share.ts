import { type SharePermission, type ShareScope } from '@exocortex/contracts';

import { type MailBlock, type MailContent } from '../layout/content';
import { formatDay, type MailLanguage } from '../translator';

/**
 * The three mails a changed grant sends (issue #103).
 *
 * A share is a lasting change to what somebody can reach, which is why it is
 * post and not a push: it is still true tomorrow, and the person it concerns
 * is usually not looking at eXocortex when it happens.
 *
 * They say what the grant now is rather than what it was. A before-and-after
 * reads like a diff and answers the wrong question -- the reader wants to know
 * what they may do now, and the withdrawal mail is the extreme case of the
 * same rule: it names the page and stops there, because a link it cannot open
 * and a permission it no longer has are not facts it is owed.
 */

/** What a grant says, as label and value. The expiry only when there is one. */
function grantFacts(
  input: {
    permission: SharePermission;
    scope: ShareScope;
    expiresAt: string | null;
  },
  language: MailLanguage,
): MailBlock {
  const { t } = language;
  const rows = [
    { label: t('share.facts.permission'), value: t(`share.permission.${input.permission}`) },
    { label: t('share.facts.scope'), value: t(`share.scope.${input.scope}`) },
  ];
  if (input.expiresAt !== null) {
    rows.push({
      label: t('share.facts.expiresAt'),
      value: formatDay(language, new Date(input.expiresAt)),
    });
  }
  return { kind: 'facts', rows };
}

export function shareGrantedMail(
  input: {
    sharedByName: string;
    documentTitle: string;
    permission: SharePermission;
    scope: ShareScope;
    url: string;
    expiresAt: string | null;
  },
  language: MailLanguage,
): MailContent {
  const { t } = language;
  const words = { actor: input.sharedByName, title: input.documentTitle };
  return {
    subject: t('common.subject', { subject: t('share.granted.subject', words) }),
    preheader: t('share.granted.preheader', {
      permission: t(`share.permission.${input.permission}`),
      scope: t(`share.scope.${input.scope}`),
    }),
    heading: t('share.granted.heading', words),
    greeting: t('common.greeting'),
    blocks: [
      { kind: 'paragraph', text: t('share.granted.body', words) },
      grantFacts(input, language),
      { kind: 'action', label: t('share.open'), url: input.url },
      { kind: 'paragraph', text: t('share.granted.noMembership') },
    ],
  };
}

export function shareChangedMail(
  input: {
    changedByName: string;
    documentTitle: string;
    permission: SharePermission;
    scope: ShareScope;
    url: string;
    expiresAt: string | null;
  },
  language: MailLanguage,
): MailContent {
  const { t } = language;
  const words = { actor: input.changedByName, title: input.documentTitle };
  return {
    subject: t('common.subject', { subject: t('share.changed.subject', words) }),
    preheader: t('share.changed.preheader', {
      permission: t(`share.permission.${input.permission}`),
      scope: t(`share.scope.${input.scope}`),
    }),
    heading: t('share.changed.heading'),
    greeting: t('common.greeting'),
    blocks: [
      { kind: 'paragraph', text: t('share.changed.body', words) },
      grantFacts(input, language),
      { kind: 'action', label: t('share.open'), url: input.url },
    ],
  };
}

export function shareRevokedMail(
  input: {
    revokedByName: string;
    documentTitle: string;
    url: string;
  },
  { t }: MailLanguage,
): MailContent {
  const words = { actor: input.revokedByName, title: input.documentTitle };
  return {
    subject: t('common.subject', { subject: t('share.revoked.subject', words) }),
    preheader: t('share.revoked.preheader', words),
    heading: t('share.revoked.heading'),
    greeting: t('common.greeting'),
    blocks: [
      { kind: 'paragraph', text: t('share.revoked.body', words) },
      // A plain link, not a button: nothing here is an action the reader is
      // being asked to take.
      { kind: 'link', label: t('share.revoked.stillShared'), url: input.url },
    ],
  };
}
