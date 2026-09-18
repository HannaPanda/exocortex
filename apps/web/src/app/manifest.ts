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
/**
 * Next's manifest type predates the share target, which is a W3C extension
 * rather than part of the core manifest. Declaring the extra member is what
 * keeps this file free of a cast: the returned object is wider than
 * `MetadataRoute.Manifest`, and everything Next reads out of it is unchanged.
 */
type ManifestWithShareTarget = MetadataRoute.Manifest & {
  share_target: {
    action: string;
    method: 'GET';
    enctype: string;
    params: { title: string; text: string; url: string };
  };
};

export default function manifest(): ManifestWithShareTarget {
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
    /*
     * "Teilen an eXocortex" (issue #72). A GET target hands the share over as
     * query parameters, which `/teilen` reads on the server; a POST one would
     * have to be caught by the service worker, and that worker exists to make
     * the app installable, not to answer requests. Android often puts a shared
     * link into `text` rather than into `url`, so the page reads the address
     * out of whatever arrives instead of trusting the field.
     */
    share_target: {
      action: '/teilen',
      method: 'GET',
      enctype: 'application/x-www-form-urlencoded',
      params: { title: 'title', text: 'text', url: 'url' },
    },
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
