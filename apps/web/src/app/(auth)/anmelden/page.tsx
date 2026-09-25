import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';

import { SignInForm } from '@/components/auth/sign-in-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signIn');
  return { title: t('metaTitle') };
}

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
