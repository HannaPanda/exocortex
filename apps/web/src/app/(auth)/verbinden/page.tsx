import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';

import { OAuthConsentForm } from '@/components/auth/oauth-consent-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.consent');
  return { title: t('metaTitle') };
}

/**
 * Where the OAuth authorization endpoint sends a signed-in person before it
 * hands an access token to a remote MCP client (ChatGPT, an agent on someone
 * else's machine). See `docs/mcp.md`.
 */
export default function OAuthConsentPage() {
  return (
    <Suspense fallback={null}>
      <OAuthConsentForm />
    </Suspense>
  );
}
