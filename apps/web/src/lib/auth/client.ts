'use client';

import { createAuthClient } from 'better-auth/react';

/**
 * Better Auth browser client.
 *
 * It talks to `/api/auth/*` on the same origin, which nginx (production) or the
 * Next.js rewrite (development) forwards to the NestJS API. The client never
 * imports server-side auth code.
 */
export const authClient = createAuthClient({
  baseURL: typeof window === 'undefined' ? 'http://localhost:3210' : window.location.origin,
  basePath: '/api/auth',
});

export const { useSession, signIn, signOut, signUp, requestPasswordReset, resetPassword } =
  authClient;
