'use client';

import * as React from 'react';

/**
 * Registers the service worker in `public/sw.js`.
 *
 * A browser only offers to install a web app once a service worker with a fetch
 * handler is registered, which is the whole reason ours exists; see the comment
 * at the top of that file for what it deliberately does not do.
 *
 * Development is left out on purpose: a registered worker outlives the dev
 * server, and having one sit in front of the HMR reloads buys nothing.
 */
export function ServiceWorkerRegistration() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', {
          scope: '/',
          // Never take the worker script itself from the HTTP cache, so a
          // deploy reaches installed apps on the next visit rather than
          // whenever the cached copy happens to expire.
          updateViaCache: 'none',
        })
        .catch((error: unknown) => {
          // Installability is a nicety; the app works without it.
          console.warn('Service worker registration failed', error);
        });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }

    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
