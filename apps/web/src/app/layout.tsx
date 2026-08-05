import type { Metadata, Viewport } from 'next';

import { Providers } from '@/components/providers';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Exocortex',
    template: '%s · Exocortex',
  },
  description: 'Exocortex: dein gemeinsames externes Gehirn.',
  applicationName: 'Exocortex',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  /* Must stay in sync with `--background` in packages/ui/src/tokens.css.
     The browser chrome cannot read a CSS custom property, so this is the one
     place where the value is duplicated. */
  themeColor: '#0e0f14',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de" data-theme="dark" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
