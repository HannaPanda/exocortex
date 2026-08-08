import type { NextConfig } from 'next';

/**
 * The browser always talks to the same origin:
 *  * in production nginx routes `/api`, `/realtime` and `/collab`
 *  * in development the rewrite below proxies `/api` to the local API process
 *
 * This keeps session cookies first-party in both environments.
 */
const apiOrigin = process.env.API_URL ?? 'http://127.0.0.1:3211';

const isDevelopment = process.env.NODE_ENV === 'development';

/**
 * Origin of the collaboration WebSocket, for `connect-src`. Only the origin is
 * kept: CSP matches scheme, host and port, never the path.
 */
const collaborationOrigin = ((): string => {
  const configured = process.env.PUBLIC_COLLABORATION_URL;
  if (configured === undefined) return '';
  try {
    return new URL(configured).origin;
  } catch {
    // A malformed value must not take the whole policy down with it; the
    // same-origin `'self'` covers the deployed setup either way.
    return '';
  }
})();

/**
 * Content Security Policy.
 *
 * Exocortex renders content it did not write: pasted Markdown, text extracted
 * from uploaded PDFs, answers from a language model, and soon pages written by
 * a second person. React escapes all of it and the codebase contains no
 * `dangerouslySetInnerHTML`, so this is defence in depth rather than the only
 * line -- but "the only line" is exactly what it becomes the day one of those
 * two facts stops being true.
 *
 * `script-src` still allows `'unsafe-inline'`. The strict alternative is a
 * per-request nonce, which Next.js can only apply while rendering on demand:
 * adopting it would turn every statically generated page dynamic, on a host
 * that already shares its eight cores with a dozen other services. The
 * directives that cost nothing are the tight ones, and they are the ones that
 * blunt a real XSS: `connect-src` and `form-action` keep stolen data from
 * leaving the origin, `object-src` and `base-uri` close two classic injection
 * routes, and `frame-ancestors` states the clickjacking rule that
 * `X-Frame-Options` only approximates.
 *
 * Everything the app loads is same-origin: attachments, images, video, audio
 * and PDFs all come from `/api/attachments/:id/download`, and the collaboration
 * socket shares the origin too. `blob:` is needed because a download is handed
 * to the browser through `URL.createObjectURL`.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  // `'self'` already covers a same-origin `wss:` under CSP level 3, but the
  // collaboration endpoint is named explicitly so the policy keeps holding if it
  // ever moves to a host of its own. In development the API and the
  // collaboration server answer on their own localhost ports.
  `connect-src 'self' ${collaborationOrigin}${isDevelopment ? ' http://localhost:* ws://localhost:*' : ''}`,
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  'upgrade-insecure-requests',
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Both packages are consumed as TypeScript source: packages/ui so Tailwind can
  // see its class names, packages/editor so the browser bundle shares one ESM
  // copy of prosemirror-* with @tiptap/* (see packages/editor/package.json).
  transpilePackages: ['@exocortex/ui', '@exocortex/editor'],
  // `prosemirror-tables` registers `CellSelection` under the global `Selection`
  // JSON-id registry (prosemirror-state) as a module-load side effect. Since
  // `@exocortex/editor` (which pulls it in via `@tiptap/extension-table`) is
  // transpiled, Turbopack's server build re-bundles that side effect into more
  // than one internal module graph for a page that reaches it from a Client
  // Component (the AI chat panel is in the shared app shell, so this now
  // includes every authenticated page). Both copies run in the same process
  // and the second registration throws "Duplicate use of selection JSON ID
  // cell". Excluding the package from bundling makes Next load it once via a
  // plain Node `require`, which is a real singleton across the whole build.
  serverExternalPackages: ['prosemirror-tables'],
  experimental: {
    // The same registration breaks the browser bundle, where
    // `serverExternalPackages` cannot reach. Scope hoisting merges a large group
    // of modules -- `prosemirror-tables` among them -- into one factory and then
    // registers that single factory under all 41 module ids of the group. The
    // browser runtime's module cache is keyed by id, so importing two ids of the
    // same group runs the factory twice, and the second run re-registers `cell`.
    // `buildEditorExtensions` imports several of those ids, so it triggers this
    // by itself. Scope hoisting is on by default in builds and always off in
    // development, which is why only the deployed app was affected.
    turbopackScopeHoisting: false,
  },
  productionBrowserSourceMaps: true,
  typedRoutes: false,
  env: {
    PUBLIC_API_URL: process.env.PUBLIC_API_URL ?? 'http://localhost:3211',
    PUBLIC_COLLABORATION_URL: process.env.PUBLIC_COLLABORATION_URL ?? 'ws://localhost:3212',
  },
  async rewrites() {
    if (process.env.NODE_ENV === 'production') return [];
    return [
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
      { source: '/docs/:path*', destination: `${apiOrigin}/docs/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Kept alongside `frame-ancestors` for browsers that read only this.
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ];
  },
};

export default nextConfig;
