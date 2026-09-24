import { type DocumentShare } from '@exocortex/contracts';

/**
 * The words for one grant, shared by the page's share dialog and the list of
 * everything this account has handed out. Two places that describe the same
 * grant differently would be two answers to "what did I give away".
 */

/** One sentence per grant, in the words somebody would use about it. */
export function describeShare(share: DocumentShare): string {
  const who =
    share.kind === 'PUBLIC_LINK'
      ? `Öffentlicher Link (…${share.tokenPrefix ?? ''})`
      : (share.grantee?.email ?? 'Unbekanntes Konto');
  const reach = share.scope === 'SUBTREE' ? ', mit allem darunter' : '';
  const right = share.permission === 'WRITE' ? 'darf bearbeiten' : 'darf lesen';
  const until =
    share.expiresAt === null
      ? ''
      : `, bis ${new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(share.expiresAt))}`;
  return `${who}: ${right}${reach}${until}`;
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
export function revokeConsequence(share: DocumentShare, where: 'dialog' | 'list'): string {
  const reach = share.scope === 'SUBTREE' ? ' Das gilt für diese Seite und alles darunter.' : '';
  if (share.kind === 'PUBLIC_LINK') {
    return (
      `Die Adresse funktioniert danach für niemanden mehr, auch nicht für jemanden, ` +
      `der sie weitergereicht bekommen hat. Sie lässt sich nicht wiederherstellen: ` +
      `ein neuer Link bekommt eine neue Adresse.${reach}`
    );
  }
  const who = share.grantee?.email ?? 'Dieses Konto';
  const regrant =
    where === 'dialog'
      ? 'Du kannst die Freigabe oben jederzeit neu erteilen.'
      : 'Du kannst sie im Teilen-Dialog der Seite jederzeit neu erteilen.';
  return (
    `${who} verliert den Zugriff sofort, auch in einer Sitzung, die gerade offen ist. ` +
    `${regrant}${reach}`
  );
}

export type ShareState = 'active' | 'expired' | 'revoked';

export const SHARE_STATE_LABELS: Record<ShareState, string> = {
  active: 'Aktiv',
  expired: 'Abgelaufen',
  revoked: 'Zurückgezogen',
};

/**
 * Whether a grant still works. An expired grant has no `revokedAt` and would
 * read as live without this, although nobody can use it any more.
 */
export function shareStateOf(share: DocumentShare, now: number): ShareState {
  if (share.revokedAt !== null) return 'revoked';
  if (share.expiresAt !== null && new Date(share.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}
