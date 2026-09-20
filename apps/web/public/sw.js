/*
 * eXocortex service worker.
 *
 * It exists so the browser offers "install", not so the app works offline: a
 * PWA is only installable once a service worker with a fetch handler is
 * registered. Caching anything here would be actively wrong -- the canonical
 * state of a document is a Yjs update held by the collaboration server, and a
 * stale copy of a page served from a cache would look like the real thing while
 * silently disagreeing with what every other client sees. Offline editing, if
 * it ever happens, belongs in the y-indexeddb layer that already exists, not in
 * an HTTP cache.
 *
 * So: every request goes to the network. The only thing this worker adds is an
 * answer for a navigation that fails because the device has no connection,
 * where the browser would otherwise show its own error page inside the app
 * window -- which, in a standalone window with no address bar, is a dead end.
 */

/*
 * The offline page carries its own copy of the design system instead of the
 * semantic tokens from packages/ui/src/tokens.css. It has to render when the
 * network is gone, which is exactly when that stylesheet cannot be fetched, and
 * nothing is cached. It is the same unavoidable duplication as `themeColor` in
 * app/layout.tsx.
 *
 * So the values below are copied verbatim from tokens.css rather than
 * approximated: the same OKLCH strings, so a change to the palette is found by
 * grepping for the old value and this page is never the last surface still
 * wearing a retired scheme. The font stack, the type ladder, the radius, the
 * focus ring and the one-pixel press are likewise the ones in
 * packages/ui/src/styles.css. Inter itself will usually not load offline, which
 * is what the fallback chain after it is for.
 */
const OFFLINE_PAGE = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#344955">
<title>Offline · eXocortex</title>
<style>
  :root {
    color-scheme: dark;
    --background: oklch(0.393 0.033 234); /* #344955, the brand slate */
    --foreground: oklch(0.933 0.003 248); /* #E7E9EB, the brand light */
    --muted-foreground: oklch(0.832 0.013 240);
    --primary: oklch(0.796 0.155 72); /* #F9AA33, the brand amber */
    --primary-foreground: oklch(0.255 0.04 234);
    --ring: oklch(0.796 0.155 72);
  }
  body {
    margin: 0;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 1.5rem;
    text-align: center;
    background: var(--background);
    color: var(--foreground);
    font-family: "Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, "Noto Sans", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* The page-title rung of the ladder: 1.75rem at weight 720 with the tracking
     tightened to match. Without the variable font loaded the axis snaps to 700,
     which is the intended fallback rather than a different design. */
  h1 {
    margin: 0;
    font-size: 1.75rem;
    line-height: 1.15;
    font-weight: 720;
    letter-spacing: -0.035em;
    text-wrap: balance;
  }
  p {
    margin: 0;
    max-width: 32rem;
    color: var(--muted-foreground);
    font-size: 0.9375rem;
    line-height: 1.625;
    text-wrap: pretty;
  }
  button {
    margin-top: 0.5rem;
    touch-action: manipulation;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 2.25rem;
    padding: 0 1rem;
    border: 0;
    border-radius: 0.5rem;
    background: var(--primary);
    color: var(--primary-foreground);
    font-family: inherit;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }
  /* Focus states are part of the contract here too, and the press is the
     one-pixel drop the rest of the product uses. */
  button:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  button:active { transform: translateY(1px); }
  @media (prefers-reduced-motion: reduce) {
    button:active { transform: none; }
  }
</style>
</head>
<body>
  <h1>Keine Verbindung</h1>
  <p>eXocortex erreicht den Server gerade nicht. Sobald du wieder online bist, geht es hier weiter.</p>
  <button type="button" onclick="location.reload()">Erneut versuchen</button>
</body>
</html>`;

self.addEventListener('install', () => {
  // Nothing to precache, so the new worker can take over at once.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/*
 * Push notifications (issue #30, ADR-048).
 *
 * The payload is the JSON of `pushNotificationPayloadSchema` in
 * `@exocortex/contracts`. A service worker cannot import a package, so these
 * field names are the second copy of that contract; changing one means
 * changing both.
 */
self.addEventListener('push', (event) => {
  // A push with no data is a wake-up from the push service itself, or a
  // message this version does not understand. Showing nothing would be a
  // silent failure that no platform allows anyway -- a permission granted and
  // then not used costs the app its permission in Chrome.
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }

  const title = payload && payload.title ? payload.title : 'eXocortex';
  const body = payload && payload.body ? payload.body : 'Es gibt etwas Neues.';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      // The small monochrome mark Android puts in the status bar. The maskable
      // icon is the closest thing we have to one; Android silhouettes it.
      badge: '/icons/icon-maskable-512.png',
      // A tag replaces the previous notification carrying it, which is how
      // three replies to the same page stay one line on a lock screen.
      tag: (payload && payload.tag) || undefined,
      // Never re-alert for a replacement: the phone buzzes for the first
      // comment on a page and updates quietly for the rest.
      renotify: false,
      data: { url: (payload && payload.url) || '/' },
    }),
  );
});

/*
 * Tapping a notification.
 *
 * An app that is already open is focused and steered, rather than opened a
 * second time: two windows of the same workspace is exactly what somebody
 * tapping a reminder does not want.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        // Same origin is guaranteed: the API refuses a notification pointing
        // anywhere else. So any open window of this app can serve.
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client) await client.navigate(target).catch(() => undefined);
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});

/*
 * A push service may replace a subscription at any time, and the only warning
 * is this event. Re-registering here is not possible -- the application server
 * key lives in the page, not in the worker -- so the page does it on its next
 * start, which is what `usePushDevices` compares endpoints for.
 */
self.addEventListener('pushsubscriptionchange', () => {
  // Deliberately empty: see above. It is declared so the absence of a handler
  // is a decision in the file rather than an omission.
});

self.addEventListener('fetch', (event) => {
  // Only page navigations. Everything else -- RSC payloads, /api calls, the
  // collaboration socket, attachments -- is left to the browser untouched.
  if (event.request.mode !== 'navigate') return;

  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(OFFLINE_PAGE, {
          status: 503,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        }),
    ),
  );
});
