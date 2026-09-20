import { type SharePermission, type ShareScope } from '@exocortex/contracts';

import { type RenderedMail } from '../types';

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

const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'long' });

/** What the grant allows, in the words the share dialog uses. */
function permissionLine(permission: SharePermission): string {
  return permission === 'WRITE' ? 'Lesen und Bearbeiten' : 'Nur Lesen';
}

/** How far the grant reaches. */
function scopeLine(scope: ShareScope): string {
  return scope === 'SUBTREE' ? 'Die Seite und alles, was darunter hängt' : 'Nur diese eine Seite';
}

/** What a grant says, as lines. The expiry only when there is one. */
function grantLines(input: {
  permission: SharePermission;
  scope: ShareScope;
  expiresAt: string | null;
}): string[] {
  const lines = [
    `Erlaubt: ${permissionLine(input.permission)}`,
    `Umfang: ${scopeLine(input.scope)}`,
  ];
  if (input.expiresAt !== null) {
    lines.push(`Gilt bis: ${dateFormat.format(new Date(input.expiresAt))}`);
  }
  return lines;
}

export function shareGrantedMail(input: {
  sharedByName: string;
  documentTitle: string;
  permission: SharePermission;
  scope: ShareScope;
  url: string;
  expiresAt: string | null;
}): RenderedMail {
  return {
    subject: `eXocortex: ${input.sharedByName} hat „${input.documentTitle}“ mit dir geteilt`,
    text: [
      'Hallo,',
      '',
      `${input.sharedByName} hat die Seite „${input.documentTitle}“ in eXocortex mit dir geteilt.`,
      '',
      ...grantLines(input),
      '',
      'Hier kommst du hin:',
      '',
      input.url,
      '',
      'Du musst dafür in keinem Arbeitsbereich Mitglied sein. Die Seite steht ab jetzt',
      'in deiner Liste „Mit mir geteilt“.',
      '',
      'eXocortex',
    ].join('\n'),
  };
}

export function shareChangedMail(input: {
  changedByName: string;
  documentTitle: string;
  permission: SharePermission;
  scope: ShareScope;
  url: string;
  expiresAt: string | null;
}): RenderedMail {
  return {
    subject: `eXocortex: Deine Freigabe für „${input.documentTitle}“ hat sich geändert`,
    text: [
      'Hallo,',
      '',
      `${input.changedByName} hat geändert, was du an der Seite „${input.documentTitle}“ darfst.`,
      'Es gilt ab sofort:',
      '',
      ...grantLines(input),
      '',
      'Hier kommst du hin:',
      '',
      input.url,
      '',
      'eXocortex',
    ].join('\n'),
  };
}

export function shareRevokedMail(input: {
  revokedByName: string;
  documentTitle: string;
  url: string;
}): RenderedMail {
  return {
    subject: `eXocortex: Dein Zugang zu „${input.documentTitle}“ ist beendet`,
    text: [
      'Hallo,',
      '',
      `${input.revokedByName} hat deine Freigabe für die Seite „${input.documentTitle}“ in`,
      'eXocortex zurückgezogen. Die Seite lässt sich damit nicht mehr öffnen.',
      '',
      'Was weiterhin mit dir geteilt ist, steht hier:',
      '',
      input.url,
      '',
      'eXocortex',
    ].join('\n'),
  };
}
