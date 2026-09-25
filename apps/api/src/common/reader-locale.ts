import { type Locale } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { LOCALE_COOKIE, resolveLocale } from '@exocortex/i18n';

export interface ReaderLocaleHeaders {
  cookie?: string | string[] | undefined;
  'accept-language'?: string | string[] | undefined;
}

function single(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function cookieValue(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * The locale of the person reading this response (issue #98, ADR-062).
 *
 * The same order the browser resolves in: the account's choice, then this
 * browser's cookie, then `Accept-Language`, then German. An MCP client sends
 * neither cookie nor header, so for an agent it is the account's choice or
 * German, which is the language the account would see in the browser too.
 *
 * Only for text the requester reads. A mail or a push is read by somebody
 * else, and follows the recipient's `User.locale` instead.
 */
export async function readerLocale(
  prisma: PrismaClient,
  userId: string | null,
  headers: ReaderLocaleHeaders,
): Promise<Locale> {
  const user =
    userId === null
      ? null
      : await prisma.user.findUnique({ where: { id: userId }, select: { locale: true } });
  return resolveLocale({
    preference: user?.locale ?? null,
    cookie: cookieValue(single(headers.cookie), LOCALE_COOKIE),
    acceptLanguage: single(headers['accept-language']),
  });
}
