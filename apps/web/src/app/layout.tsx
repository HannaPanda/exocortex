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
  themeColor: '#191a19',
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
