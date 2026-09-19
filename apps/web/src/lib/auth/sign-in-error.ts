/**
 * The sentence a person reads when a sign-in was refused.
 *
 * Every refusal used to read "E-Mail-Adresse oder Passwort ist falsch", which
 * is a claim about the credentials and is untrue whenever the server refused
 * the request without ever looking at them. The rate limiter is the case that
 * matters: somebody who has just been throttled is told their password is
 * wrong, retypes a password that was right all along, and spends the attempts
 * on the very limiter that is blocking them. The same sentence in front of a
 * failed deployment sends them to the password reset instead of to a second
 * attempt a minute later.
 *
 * Naming the limiter gives nothing away about an account: the limit counts per
 * client address rather than per address, so the answer is the same whether or
 * not the account exists. The wrong-credentials sentence stays deliberately
 * vague about which half was wrong, which is the part that would enumerate
 * accounts.
 */
export function signInErrorMessage(status: number | undefined): string {
  if (status === 429) {
    return 'Zu viele Anmeldeversuche. Bitte warte eine Minute und versuche es dann erneut.';
  }
  // 0 is what the client reports when the request never arrived anywhere.
  if (status === undefined || status === 0 || status >= 500) {
    return 'Die Anmeldung ist gerade nicht möglich. Bitte versuche es gleich noch einmal.';
  }
  return 'E-Mail-Adresse oder Passwort ist falsch.';
}
