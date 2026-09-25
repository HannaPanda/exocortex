/**
 * Which sentence a person reads when a sign-in was refused, as a key under
 * `auth.signIn` in the message catalogue.
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
export type SignInErrorKey = 'tooManyAttempts' | 'unavailable' | 'wrongCredentials';

export function signInErrorKey(status: number | undefined): SignInErrorKey {
  if (status === 429) return 'tooManyAttempts';
  // 0 is what the client reports when the request never arrived anywhere.
  if (status === undefined || status === 0 || status >= 500) return 'unavailable';
  return 'wrongCredentials';
}
