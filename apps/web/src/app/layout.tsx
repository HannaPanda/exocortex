import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';

import { Providers } from '@/components/providers';
import { ServiceWorkerRegistration } from '@/components/service-worker-registration';

import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell.metadata');
  return {
    title: {
      default: 'eXocortex',
      template: '%s · eXocortex',
    },
    description: t('description'),
    applicationName: 'eXocortex',
    robots: { index: false, follow: false },
    /* iOS ignores the web app manifest's `display` and reads these instead, so an
       icon added to the home screen there opens in its own window too. The status
       bar is opaque black rather than translucent on purpose: a translucent one
       puts the app's own content under the notch, and nothing in the layout
       reserves the safe area for it. */
    appleWebApp: {
      capable: true,
      title: 'eXocortex',
      statusBarStyle: 'black',
    },
  };
}

export const viewport: Viewport = {
  /* Must stay in sync with `--background` in packages/ui/src/tokens.css.
     The browser chrome cannot read a CSS custom property, so this is the one
     place where the value is duplicated. */
  themeColor: '#344955',
  width: 'device-width',
  initialScale: 1,
};

/**
 * `lang` follows the resolved interface language (issue #98), so a screen
 * reader pronounces the page in the language it is written in and the
 * browser hyphenates and offers translation correctly. The provider hands
 * the client components the messages of that language only.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} data-theme="dark" suppressHydrationWarning>
      <body>
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
