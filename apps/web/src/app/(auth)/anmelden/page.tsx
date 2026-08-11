import type { Metadata } from 'next';
import { Suspense } from 'react';

import { SignInForm } from '@/components/auth/sign-in-form';

export const metadata: Metadata = { title: 'Anmelden' };

/**
 * The form reads the query string, because an OAuth authorization request
 * arrives here with its parameters attached and has to be resumed afterwards.
 * That makes it a client boundary Next cannot prerender through, hence the
 * `Suspense`.
 */
export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}
