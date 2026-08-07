import type { NextConfig } from 'next';

/**
 * The browser always talks to the same origin:
 *  * in production nginx routes `/api`, `/realtime` and `/collab`
 *  * in development the rewrite below proxies `/api` to the local API process
 *
 * This keeps session cookies first-party in both environments.
 */
const apiOrigin = process.env.API_URL ?? 'http://127.0.0.1:3211';

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
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ];
  },
};

export default nextConfig;
