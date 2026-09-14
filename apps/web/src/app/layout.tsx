import type { Metadata, Viewport } from 'next';

import { Providers } from '@/components/providers';
import { ServiceWorkerRegistration } from '@/components/service-worker-registration';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'eXocortex',
    template: '%s · eXocortex',
  },
  description: 'eXocortex: dein gemeinsames externes Gehirn.',
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

export const viewport: Viewport = {
  /* Must stay in sync with `--background` in packages/ui/src/tokens.css.
     The browser chrome cannot read a CSS custom property, so this is the one
     place where the value is duplicated. */
  themeColor: '#344955',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de" data-theme="dark" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
