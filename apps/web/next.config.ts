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
