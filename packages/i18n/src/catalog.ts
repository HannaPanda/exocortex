import { createTranslator } from 'use-intl/core';

import { DEFAULT_LOCALE, type Locale } from '@exocortex/contracts';

import { CATALOG, NAMESPACES } from './catalog.generated.js';

/**
 * The message catalogue, server side only (issue #98, ADR-062).
 *
 * A separate entry point from `@exocortex/i18n` on purpose: it imports every
 * message file of every locale, which is right for the API, the worker and the
 * Next.js request config, and wrong for a browser bundle. A client component
 * gets its messages through `NextIntlClientProvider`, for its own locale only.
 */

/** The German catalogue's shape, which is every catalogue's shape. */
export type Messages = (typeof CATALOG)['de'];
export type Namespace = (typeof NAMESPACES)[number];

export { NAMESPACES };

type Tree = { readonly [key: string]: string | Tree };

/**
 * `target` with every key it lacks taken from `fallback`.
 *
 * The i18n gate refuses a catalogue with a missing key, so in a build that
 * passed this changes nothing. It exists for the deployment that is running
 * while a gate is being fixed: a German sentence in a French interface is a
 * blemish, a raw key like `settings.language.title` is a broken screen.
 */
function withFallback(target: Tree, fallback: Tree): Tree {
  const merged: Record<string, string | Tree> = {};
  for (const [key, value] of Object.entries(fallback)) {
    const own = target[key];
    if (typeof value === 'string') {
      merged[key] = typeof own === 'string' ? own : value;
    } else {
      merged[key] = withFallback(typeof own === 'object' ? own : {}, value);
    }
  }
  return merged;
}

const merged = new Map<Locale, Messages>();

/** Every namespace for `locale`, with German behind each missing key. */
export function messagesFor(locale: Locale): Messages {
  const cached = merged.get(locale);
  if (cached !== undefined) return cached;
  const source = CATALOG[DEFAULT_LOCALE] as unknown as Tree;
  const own = CATALOG[locale] as unknown as Tree;
  const result = (locale === DEFAULT_LOCALE
    ? own
    : withFallback(own, source)) as unknown as Messages;
  merged.set(locale, result);
  return result;
}

/**
 * Only the namespaces a surface needs. The browser gets the web namespaces
 * and not, say, the mail templates: whatever is handed to the client provider
 * is serialised into every page.
 */
export function pickMessages(locale: Locale, namespaces: readonly Namespace[]): Partial<Messages> {
  const all = messagesFor(locale);
  const picked: Partial<Record<Namespace, unknown>> = {};
  for (const namespace of namespaces) picked[namespace] = all[namespace];
  return picked as Partial<Messages>;
}

/**
 * A translator for text the server renders: a mail, a push, a diagnosis, a
 * help entry. Always the reader's locale (ADR-062), which for a mail or a push
 * is the recipient's and not the requester's.
 *
 * `use-intl/core` is the engine `next-intl` runs in the browser, so the same
 * ICU message formats identically on both sides.
 */
export function serverTranslator<N extends Namespace>(locale: Locale, namespace: N) {
  return createTranslator<Messages, N>({
    locale,
    messages: messagesFor(locale),
    namespace,
    onError: () => undefined,
  });
}
