import type { MetadataRoute } from 'next';

/**
 * Web app manifest: this is what makes eXocortex installable on a phone or a
 * desktop, so it opens in its own window instead of a browser tab.
 *
 * The colours are duplicated from `--background` in packages/ui/src/tokens.css
 * for the same reason as `viewport.themeColor` in `layout.tsx`: neither the
 * browser chrome nor the manifest can read a CSS custom property. Keep the
 * three in sync.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'eXocortex',
    short_name: 'eXocortex',
    description: 'eXocortex: dein gemeinsames externes Gehirn.',
    lang: 'de',
    dir: 'ltr',
    // The root route sends a signed-in person to their last workspace and
    // everyone else to the login page, which is what an app icon should do.
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#344955',
    theme_color: '#344955',
    categories: ['productivity'],
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      // Android crops an icon to whatever shape the launcher uses, so the
      // maskable variant keeps the mark inside the safe zone on its own plate.
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
